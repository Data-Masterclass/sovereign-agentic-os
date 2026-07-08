/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, buildGoldJoin } from '@/lib/data/store';
import { assetTarget } from '@/lib/data/store-fqn';
import { stepperStages, stageArtifact, canBuildStage } from '@/lib/data/panels';
import { buildStage } from '@/lib/data/build/server';
import {
  goldJoinPlan,
  goldMeasureToCube,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@/lib/data/transform';
import type { DatasetUpstream } from '@/lib/data/dataset-schema';
import type { ExecuteIdentity } from '@/lib/governed';

export const dynamic = 'force-dynamic';

type PickIn = { datasetId?: string; type?: string; on?: unknown[] };

/**
 * Gold JOIN builder — REAL dataset REUSE via a governed CTAS. The panel sends the
 * datasetIds to join (never table names), the keys, the projected columns + measures;
 * here we (server-authoritatively):
 *   1. resolve each picked datasetId through `getDataset` — the canView guard, so a
 *      caller can only join a dataset they may READ (a non-visible id → 403);
 *   2. compile ONE allowlisted `CREATE OR REPLACE TABLE … AS SELECT` targeting the
 *      CALLER's own schema (`goldJoinPlan`);
 *   3. run it through the Build adapter (dbt.apply = executeRun AS the caller → Trino→
 *      OPA masks the reads of every joined table) + the verify probe.
 * The Gold dot lights — and the measures + multi-upstream lineage land in dataset.yaml
 * — ONLY when the Build report is ✓. A rejected statement / Trino error is surfaced
 * verbatim (honest ✗) and nothing is recorded. The client-sent SQL is never trusted.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      picks?: PickIn[];
      dimensions?: GoldDimension[];
      measures?: GoldMeasure[];
    };

    const dataset = getDataset(id, user); // view-scope guard on the base
    if (!canBuildStage(dataset.versions, 'gold')) {
      return NextResponse.json({ error: 'Bring in the Silver version before joining it' }, { status: 400 });
    }

    const rawPicks = Array.isArray(body.picks) ? body.picks : [];
    if (rawPicks.length === 0) {
      return NextResponse.json({ error: 'Pick at least one dataset to join' }, { status: 400 });
    }

    const identity: ExecuteIdentity = {
      principal: user.domains[0] ?? user.id,
      uid: user.id,
      domains: user.domains,
      role: user.role,
    };

    // Resolve each pick to a physical FQN through the canView guard (403 if not visible).
    const joins: ResolvedJoin[] = [];
    const upstreams: DatasetUpstream[] = [];
    for (const p of rawPicks) {
      const up = getDataset(String(p?.datasetId ?? ''), user); // throws 403/404
      const fqn = assetTarget(up);
      const type: JoinType = p?.type === 'left' ? 'left' : 'inner';
      const on = Array.isArray(p?.on) ? (p!.on as ResolvedJoin['on']) : [];
      joins.push({ table: fqn, type, on });
      upstreams.push({ datasetId: up.id, name: up.name, fqn, joinType: type });
    }

    const dimensions = Array.isArray(body.dimensions) ? body.dimensions : [];
    const measures = Array.isArray(body.measures) ? body.measures : [];

    // Compile server-side (throws TransformError → 400 with the real reason).
    const plan = goldJoinPlan(dataset, identity, joins, dimensions, measures);

    // Personal-lane builds must run under the UID (not the domain principal) so
    // Trino→OPA recognises the caller as the `personal_<uid>` owner — the same
    // rule as the Silver transform route.
    if (plan.schema.startsWith('personal_')) identity.principal = user.id;

    // targetFqn: probe the exact table the CTAS wrote (personal vs domain schema).
    const build = await buildStage(dataset, 'gold', identity.principal, { transformSql: plan.sql, identity, targetFqn: plan.target });
    if (!build.ok) {
      const failed = build.rows.find((r) => r.status === 'fail');
      return NextResponse.json(
        { build, sql: plan.sql, target: plan.target, error: failed?.error ?? 'Gold join did not pass' },
        { status: 200 },
      );
    }

    // ✓ only: record the Gold version + its compiled CTAS, the measures (feed the Cube
    // scaffold at promotion) and the multi-upstream lineage edges (the reuse).
    const updated = buildGoldJoin(id, user, {
      measures: measures.map(goldMeasureToCube),
      upstreams,
      artifact: stageArtifact(dataset.name, 'gold'),
      body: plan.sql,
    });

    return NextResponse.json({ build, sql: plan.sql, target: plan.target, dataset: updated, stages: stepperStages(updated) });
  } catch (e) {
    return errorResponse(e);
  }
}
