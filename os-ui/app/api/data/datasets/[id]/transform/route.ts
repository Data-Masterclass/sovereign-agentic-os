/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { stepperStages } from '@tabs/data/lib/panels';
import { transformSilverService } from '@tabs/data/lib/mutations-server';
import type { TransformOp } from '@tabs/data/lib/transform';

export const dynamic = 'force-dynamic';

/**
 * Silver builder — REAL transform via a governed CTAS. The guided panel sends the
 * cleaning ops; `transformSilverService` (the SAME function MCP `transform_silver`
 * calls — checklist X8) compiles them server-authoritatively into ONE allowlisted
 * `CREATE OR REPLACE TABLE … AS SELECT` targeting the CALLER's own schema, runs it
 * through the Build adapter (dbt.apply = executeRun as the caller → Trino→OPA masks
 * the reads) followed by the verify probe, registers the Silver version ONLY on a ✓,
 * launches the layer's dbt assets in Dagster from the commit this write produced, and
 * reports the governed domain copy's state honestly.
 *
 * The client-sent SQL is NEVER trusted: the service recompiles from the ops. Identity
 * is derived from the signed session, never the request body.
 */
export const POST = withRoute<{ id: string }, { ops?: TransformOp[]; columns?: string[] }>(async ({ user, params, body }) => {
  const out = await transformSilverService(user, params.id, { columns: body.columns, ops: body.ops });
  if (!out.ok) {
    // Honest ✗: nothing was registered — surface the build report + the real reason.
    return NextResponse.json({ build: out.build, sql: out.sql, target: out.target, error: out.error }, { status: 200 });
  }
  const dataset = out.dataset ?? getDataset(params.id, user);
  return NextResponse.json({
    build: out.build,
    sql: out.sql,
    target: out.target,
    dataset,
    domainTable: out.domainTable,
    stages: stepperStages(dataset),
  });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
