/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { stepperStages } from '@tabs/data/lib/panels';
import { buildGoldJoinService, rematerializeDomainTableService } from '@tabs/data/lib/mutations-server';

export const dynamic = 'force-dynamic';

/**
 * Gold builder — a governed CTAS that projects the caller's Silver (or an explicit curated
 * base) into a Gold mart, OPTIONALLY reusing other datasets by JOIN. The panel sends the
 * dataset IDS to join (never table names), the keys, the projected columns + measures;
 * `buildGoldJoinService` — the SAME function MCP `build_gold_join` calls (checklist X8) —
 * resolves every pick through the canView guard to its owner-aware physical table, compiles
 * ONE allowlisted statement into the caller's own schema, runs it through the Build adapter
 * (Trino→OPA masks every joined read) + the verify probe, records the version, measures and
 * multi-upstream lineage ONLY on a ✓, launches the Gold assets in Dagster from the commit,
 * and refreshes (or honestly reports) the governed domain copy.
 *
 * `rematerializeOnly: true` is REPAIR MODE: it skips the build and re-runs only the publish
 * CTAS for an already-promoted dataset whose domain table is missing or stale (Builder+).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
  const { id } = params;
  if (body?.rematerializeOnly === true) {
    const out = await rematerializeDomainTableService(user, id);
    return NextResponse.json({ dataset: out.dataset, domainTable: out.domainTable }, { status: out.ok ? 200 : 502 });
  }
  const out = await buildGoldJoinService(user, id, {
    baseDatasetId: body?.baseDatasetId,
    picks: body?.picks,
    dimensions: body?.dimensions,
    measures: body?.measures,
    derived: body?.derived,
    goldSpec: body?.goldSpec,
  });
  if (!out.ok) {
    return NextResponse.json({ build: out.build, sql: out.sql, target: out.target, error: out.error }, { status: 200 });
  }
  const dataset = out.dataset ?? getDataset(id, user);
  return NextResponse.json({
    build: out.build,
    sql: out.sql,
    target: out.target,
    dataset,
    domainTable: out.domainTable,
    stages: stepperStages(dataset),
  });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
