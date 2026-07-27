/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset, buildGoldJoin } from '@/lib/data/store';
import { rematerializeDomainTableLive } from '@/lib/data/publish-server';
import { roleAtLeast } from '@/lib/core/session';
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
import type { DatasetUpstream } from '@/lib/data';
import { parseGoldSpec, type GoldSpec } from '@/lib/data/dataset-schema';
import type { ExecuteIdentity } from '@/lib/infra/governed';

export const dynamic = 'force-dynamic';

type PickIn = { datasetId?: string; type?: string; on?: unknown[] };

/**
 * Gold builder — a governed CTAS that projects the caller's Silver base into a Gold
 * mart, OPTIONALLY reusing other datasets by JOIN. The panel sends the datasetIds to
 * join (never table names), the keys, the projected columns + measures; here we
 * (server-authoritatively):
 *   1. resolve each picked datasetId through `getDataset` — the canView guard, so a
 *      caller can only join a dataset they may READ (a non-visible id → 403). With ZERO
 *      picks this is a single-table Gold projection of the Silver base (no join);
 *   2. compile ONE allowlisted `CREATE OR REPLACE TABLE … AS SELECT` targeting the
 *      CALLER's own schema (`goldJoinPlan`) — the compiler requires at least one
 *      dimension or measure, so an empty Gold spec is rejected honestly;
 *   3. run it through the Build adapter (dbt.apply = executeRun AS the caller → Trino→
 *      OPA masks the reads of every joined table) + the verify probe.
 * The Gold dot lights — and the measures + multi-upstream lineage land in dataset.yaml
 * — ONLY when the Build report is ✓. A rejected statement / Trino error is surfaced
 * verbatim (honest ✗) and nothing is recorded. The client-sent SQL is never trusted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
  const { id } = params;

  const dataset = getDataset(id, user); // view-scope guard on the base

  // REPAIR MODE — `rematerializeOnly: true` skips the build entirely and just re-runs
  // the publish CTAS (owner's personal gold → domain schema). Heals promoted datasets
  // whose domain copy is missing/stale WITHOUT re-specifying the gold spec (the drift
  // class behind the Northpeak single-column dashboards). Builder+ only; never touches
  // versions/lineage/measures — the personal lane is the source of truth it copies.
  if (body?.rematerializeOnly === true) {
    if (dataset.tier === 'dataset') {
      return NextResponse.json({ error: 'Not promoted — nothing to re-materialize' }, { status: 400 });
    }
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Re-materializing the shared domain table needs Builder or above' }, { status: 403 });
    }
    const out = await rematerializeDomainTableLive(id, user);
    const domainTable = out.ok
      ? { state: 'refreshed' as const, fqn: out.fqn }
      : { state: 'stale' as const, fqn: out.fqn, reason: out.error };
    return NextResponse.json({ dataset: getDataset(id, user), domainTable }, { status: out.ok ? 200 : 502 });
  }

  if (!canBuildStage(dataset.versions, 'gold')) {
    return NextResponse.json({ error: 'Bring in the Silver version before joining it' }, { status: 400 });
  }

  // A join is OPTIONAL: 0 picks builds a single-table Gold projection of the Silver
  // base; the compiler then requires at least one dimension or measure to select.
  const rawPicks = Array.isArray(body.picks) ? body.picks : [];

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

  const dimensions = Array.isArray(body.dimensions) ? body.dimensions as GoldDimension[] : [];
  const measures = Array.isArray(body.measures) ? body.measures as GoldMeasure[] : [];

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
    // Sanitize the raw spec server-side (never trusted; stored verbatim for re-hydration).
    goldSpec: parseGoldSpec(body.goldSpec),
  });

  // Northpeak fix — MATERIALIZATION DRIFT. If the rebuilt dataset is ALREADY promoted, its
  // governed domain table (what Cube + every dashboard reads) now holds the PRIOR snapshot
  // (`buildGoldJoin` flagged it stale). Auto-refresh it when the rebuilder is a Builder+ (the
  // domain-schema write floor) so the new data reaches Cube in the same act — matching user
  // expectations ("I rebuilt it, the dashboard should update"). A creator's rebuild cannot
  // write the domain schema, so it stays honestly STALE until a Builder re-promotes it. The
  // re-materialize is best-effort: it NEVER fails the successful personal-lane rebuild — we
  // report `domainTable` so the UI can show refreshed/stale/needs-a-builder honestly.
  let domainTable: { state: 'refreshed' | 'stale' | 'not-promoted'; fqn?: string; reason?: string } =
    { state: 'not-promoted' };
  if (updated.tier !== 'dataset') {
    if (roleAtLeast(user.role, 'builder')) {
      try {
        const out = await rematerializeDomainTableLive(id, user);
        domainTable = out.ok
          ? { state: 'refreshed', fqn: out.fqn }
          : { state: 'stale', fqn: out.fqn, reason: out.error };
      } catch (e) {
        domainTable = { state: 'stale', reason: e instanceof Error ? e.message : String(e) };
      }
    } else {
      domainTable = { state: 'stale', reason: 'Rebuilt by a creator — a Builder must re-promote to refresh the shared domain table.' };
    }
  }

  const finalDataset = domainTable.state === 'refreshed' ? getDataset(id, user) : updated;
  return NextResponse.json({ build, sql: plan.sql, target: plan.target, dataset: finalDataset, domainTable, stages: stepperStages(finalDataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
