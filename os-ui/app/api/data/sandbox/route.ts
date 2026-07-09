/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { authorize, queryRun, trace } from '@/lib/infra/governed';
import {
  privatePrefix,
  pullExtract,
  promotePlan,
  type PersonalDataset,
} from '@/lib/data/personal-lane';
import { listPersonalTables } from '@/lib/data/ingest';

export const dynamic = 'force-dynamic';

/**
 * The personal lane ("My data") — a single-user workbench that does NOT bypass
 * governance. SINGLE-ENGINE: a user's own data is a physical Iceberg table queried
 * THROUGH the SAME governed Trino path (owner-principal) as every other read; there is
 * no separate personal query engine.
 *   - upload        : a file lands a real iceberg.personal_<uid> table (multipart route)
 *   - pull-extract  : runs THROUGH Trino (OPA-masked) -> a private extract
 *   - promote       : the ONLY path to shared — dbt-trino writes Iceberg + OM
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

  let body: { action?: string; name?: string; sql?: string; id?: string;
    columns?: string[]; rows?: string[][]; domain?: string; visibility?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const action = body.action;

  try {
    if (action === 'list') {
      // PHYSICAL personal Bronze tables (durable — survive restarts) unioned with the
      // in-session masked extracts. The old in-memory upload rows are gone: uploads are
      // now real Iceberg tables (POST /api/data/sandbox/upload), queryable through Trino.
      const physical = await listPersonalTables(uid);
      const extracts = listFor(uid).filter((d) => d.origin === 'extract').map(meta);
      return NextResponse.json({ prefix, datasets: [...physical, ...extracts] });
    }

    if (action === 'upload') {
      // File uploads moved to the physical path (multipart POST /api/data/sandbox/upload
      // → MinIO → data-runner → iceberg.personal_<uid>). This JSON action is retired.
      return NextResponse.json(
        { error: 'upload a file via POST /api/data/sandbox/upload (multipart) — it now lands a real Iceberg table' },
        { status: 400 },
      );
    }

    if (action === 'pull-extract') {
      const sql = (body.sql ?? '').trim();
      const name = (body.name ?? 'extract').trim();
      if (!sql) return NextResponse.json({ error: 'pull-extract needs sql' }, { status: 400 });
      // OPA gates tool access; the pull then runs THROUGH Trino (row/column masked).
      const authz = await authorize(principal, 'query');
      if (!authz.allowed) {
        return NextResponse.json(
          { error: `OPA denied ${principal} → query`, policy: authz.policy }, { status: 403 },
        );
      }
      const d = await pullExtract({ principal, sql, name, queryFn: queryRun });
      add(uid, d);
      const traced = await trace({ principal, tool: 'query', input: sql, output: d.rows });
      return NextResponse.json({
        ok: true, prefix, masked: true, policy: authz.policy, traced, dataset: meta(d),
        columns: d.columns, rows: d.rows,
      });
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
      if (!ds) return NextResponse.json({ error: 'unknown dataset' }, { status: 404 });
      const plan = promotePlan(ds, {
        domain: body.domain || principal,
        owner: user.id,
        visibility: body.visibility || 'shared',
      });
      // Scaffold: hand to the governed lane (dbt-trino + OpenMetadata). The actual
      // build is the dbt-build path; here we return the plan to review/confirm.
      return NextResponse.json({ ok: true, scaffolded: true, plan });
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
