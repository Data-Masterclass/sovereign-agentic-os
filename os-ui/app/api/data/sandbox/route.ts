/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError } from '@core/kernel/route-server';
import { requireUser } from '@core/kernel/auth';
import { authorize, queryRun, trace } from '@core/infra/governed';
import { routeFor } from '@core/infra/trino-source';
import {
  privatePrefix,
  pullExtract,
  promotePlan,
  type PersonalDataset,
} from '@tabs/data/lib/personal-lane';
import { listPersonalTables, landGridAsBronze } from '@tabs/data/lib/ingest';
import { stepperStages } from '@tabs/data/lib/panels';

export const dynamic = 'force-dynamic';

/**
 * The personal lane ("My data") — a single-user workbench that does NOT bypass
 * governance. SINGLE-ENGINE: a user's own data is a physical Iceberg table queried
 * THROUGH the SAME governed Trino path (owner-principal) as every other read; there is
 * no separate personal query engine.
 *   - upload        : a file lands a real iceberg.personal_<uid> table (multipart route)
 *   - pull-extract  : runs THROUGH Trino (OPA-masked) -> a private extract
 *   - promote       : the ONLY path to shared — dbt-trino writes Iceberg
 */

// Per-user in-process store (best-effort; mirrors the artifact-registry pattern).
const STORE = new Map<string, PersonalDataset[]>();
function listFor(uid: string): PersonalDataset[] {
  return STORE.get(uid) ?? [];
}
function add(uid: string, d: PersonalDataset): void {
  STORE.set(uid, [d, ...listFor(uid)]);
}

function meta(d: PersonalDataset) {
  return { id: d.id, name: d.name, origin: d.origin, columns: d.columns, rowCount: d.rows.length };
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  const uid = user.id;
  const principal = user.domains[0] ?? user.id;
  const prefix = privatePrefix(uid);

  let body: { action?: string; name?: string; sql?: string; id?: string; datasetId?: string;
    columns?: string[]; rows?: string[][]; domain?: string; visibility?: string };
  try {
    body = await req.json();
  } catch {
    return apiError(400, 'Invalid JSON body', 'request.invalidJson');
  }
  const action = body.action;

  try {
    if (action === 'list') {
      // PHYSICAL personal Bronze tables (durable — survive restarts) unioned with the
      // in-session masked extracts. The old in-memory upload rows are gone: uploads are
      // now real Iceberg tables (POST /api/data/sandbox/upload), queryable through Trino.
      const physical = await listPersonalTables(uid, user.domains);
      const extracts = listFor(uid).filter((d) => d.origin === 'extract').map(meta);
      return NextResponse.json({ prefix, datasets: [...physical, ...extracts] });
    }

    if (action === 'upload') {
      // File uploads moved to the physical path (multipart POST /api/data/sandbox/upload
      // → MinIO → data-runner → iceberg.personal_<uid>). This JSON action is retired.
      return apiError(400, 'upload a file via POST /api/data/sandbox/upload (multipart) — it now lands a real Iceberg table', 'data.sandbox.uploadViaMultipart');
    }

    if (action === 'pull-extract') {
      const sql = (body.sql ?? '').trim();
      const name = (body.name ?? 'extract').trim();
      if (!sql) return apiError(400, 'pull-extract needs sql', 'data.sandbox.extractNeedsSql');
      // OPA gates tool access; the pull then runs THROUGH Trino (row/column masked).
      const authz = await authorize(principal, 'query');
      if (!authz.allowed) {
        return NextResponse.json(
          { error: `OPA denied ${principal} → query`, policy: authz.policy }, { status: 403 },
        );
      }
      const d = await pullExtract({ principal, sql, name, queryFn: (q, p) => queryRun(q, p, routeFor(user, 'data-sandbox')) });
      add(uid, d);
      const traced = await trace({ principal, tool: 'query', input: sql, output: d.rows });
      return NextResponse.json({
        ok: true, prefix, masked: true, policy: authz.policy, traced, dataset: meta(d),
        columns: d.columns, rows: d.rows,
      });
    }

    if (action === 'land-bronze') {
      // "Confirm — this is my Bronze" for a pulled extract: LAND the in-session
      // extract as the dataset's REAL personal Bronze table through the SAME
      // ingest pipeline as a file upload (verify-then-dot — P0 A1). The extract
      // must exist in this session; the Bronze dot lights ONLY on apply+verify ✓.
      const datasetId = (body.datasetId ?? '').trim();
      if (!datasetId) return apiError(400, 'land-bronze needs a datasetId', 'data.sandbox.landNeedsDataset');
      const extract = listFor(uid).find((d) => d.id === body.id && d.origin === 'extract');
      if (!extract) {
        return apiError(404, 'unknown extract — pull it again before confirming (extracts are per-session)', 'data.sandbox.unknownExtract');
      }
      const r = await landGridAsBronze(user, datasetId, { columns: extract.columns, rows: extract.rows });
      if (!r.ok || !r.dataset) {
        return NextResponse.json(
          { ok: false, error: r.report.error ?? 'ingest verify failed — Bronze was not registered', report: r.report },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, report: r.report, stages: stepperStages(r.dataset) });
    }

    if (action === 'promote') {
      const id = body.id;
      // Physical personal Bronze tables (id = `personal_<uid>.bronze_<name>`) are no
      // longer in the in-process Map — synthesize a plan from the FQN; extracts still
      // resolve from the Map. (Governed promotion itself is the registry flow, T8.)
      const ds: PersonalDataset | undefined =
        listFor(uid).find((d) => d.id === id) ??
        (typeof id === 'string' && id.includes('.bronze_')
          ? { id, name: id.split('.bronze_')[1] ?? id, origin: 'upload', columns: [], rows: [] }
          : undefined);
      if (!ds) return apiError(404, 'unknown dataset', 'data.sandbox.unknownDataset');
      const plan = promotePlan(ds, {
        domain: body.domain || principal,
        owner: user.id,
        visibility: body.visibility || 'shared',
      });
      // Scaffold: hand to the governed lane (dbt-trino). The actual
      // build is the dbt-build path; here we return the plan to review/confirm.
      return NextResponse.json({ ok: true, scaffolded: true, plan });
    }

    return apiError(400, `unknown action: ${action}`, 'data.unknownActionNamed', { action: String(action) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
