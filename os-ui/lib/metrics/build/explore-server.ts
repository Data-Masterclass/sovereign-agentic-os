/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { queryRun } from '@/lib/infra/governed';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import type { Dataset, Measure } from '../../data/index.ts';
import { personalSchema, domainSchema, physicalSlug } from '../../data/store-fqn.ts';
import {
  type CubeExecutor,
  type Granularity,
  dropToSql,
  explore,
  exploreSpec,
  previewTrinoSql,
  sqlRowsToExploreRows,
} from '../explorer.ts';
import { liveMetricsReachable } from './live-clients.ts';

/**
 * Server boundary for the metric explorer. Since the metrics→Trino migration (Phase 1) a
 * metric is a VIRTUAL DECLARATION served as ONE governed Trino SELECT over the physical gold
 * mart, run UNDER the viewer's delegated identity (R3 — Trino/OPA row/column security). Cube
 * is OFF the metric read path (it stays on dashboards until Phase 2). On the local/teaching
 * laptop, where no backend exists, an honest offline-MOCK filters by the viewer's region so
 * the "two viewers see different rows" guarantee still holds. Returns the rows + the exact
 * SQL that ran, honestly labelled 'live (sql)' / 'offline-mock' / 'unavailable'.
 */

/** 'live (sql)' = the number came from a governed Trino query over the gold mart (the
 *  metric read path since Phase 1), honestly labelled. 'unavailable' = a REAL deployment
 *  whose query backend is unreachable: we return NO number rather than a fabricated
 *  offline-mock one (see metricsMustBeLive). */
export type ExploreMode = 'live' | 'live (sql)' | 'offline-mock' | 'unavailable';

/**
 * On a real deployment (OS_PROFILE ≠ 'local') the governed query backend is required — if
 * it's unreachable that's an OUTAGE, and a metric must say so, never fabricate a plausible
 * number. The offline-mock resolver (a hash-seeded demo value) is ONLY legitimate on the
 * local/laptop teaching flow, where no cluster exists and the mock is clearly a worked
 * example. This gate is what stops a made-up 286,936 from being shown as if it were a real KPI.
 */
function metricsMustBeLive(): boolean {
  return config.deploymentProfile !== 'local';
}

/**
 * The TIER-AWARE physical gold FQN a metric read targets — the linchpin of personal-dataset
 * metrics (metrics→Trino migration, Phase 1). A PERSONAL dataset (tier 'dataset') has its gold
 * ONLY in the owner's private lane (`iceberg.personal_<owner>.gold_<slug>`); a governed
 * asset/product has it in the domain schema (`iceberg.<domain>.gold_<slug>` — the same FQN
 * Cube bound to). The read runs under the delegated token's SUBJECT (R3): for a personal
 * dataset that subject IS the owner, so Trino/OPA's `is_owned_personal` grants the private
 * lane; for a governed dataset the subject's groups carry the domain membership OPA gates on.
 * TIER, not ownership, decides the schema — a governed dataset's owner still reads the shared
 * domain mart, exactly as every other viewer does (and as the pre-migration preview did).
 */
function goldReadTarget(dataset: Dataset, token: DelegatedToken): string {
  const schema = dataset.tier === 'dataset' ? personalSchema(dataset.owner) : domainSchema(dataset.domain);
  return `iceberg.${schema}.gold_${physicalSlug(dataset)}`;
}

/**
 * The offline-mock executor: a tiny region-partitioned table that ENFORCES the security
 * context exactly like Cube would, so the RLS demo is real offline. Deterministic value
 * per (member, region) so numbers are stable + the agent path agrees.
 */
function mockExecutor(): CubeExecutor {
  const REGIONS = ['DE', 'FR', 'US'];
  const valueOf = (member: string, region: string) => {
    const s = `${member}:${region}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h % 90000) + 10000;
  };
  return {
    async load(query, ctx) {
      const member = query.measures[0];
      const viewerRegion = ctx.region as string | undefined;
      const regions = viewerRegion ? REGIONS.filter((r) => r === viewerRegion) : REGIONS;
      const byRegion = query.dimensions.some((d) => d.endsWith('.region'));
      if (byRegion) {
        const regionDim = query.dimensions.find((d) => d.endsWith('.region'))!;
        return { rows: regions.map((r) => ({ [regionDim]: r, [member]: valueOf(member, r) })) };
      }
      const total = regions.reduce((sum, r) => sum + valueOf(member, r), 0);
      return { rows: [{ [member]: total }] };
    },
  };
}

export type ExploreServerResult = {
  member: string;
  rows: Record<string, unknown>[];
  securityContext: Record<string, unknown>;
  sql: string;
  mode: ExploreMode;
  /** True when Cube is up but the just-defined measure hasn't sync'd yet (soft "syncing"). */
  pending?: boolean;
  /** True on a real deployment when the semantic layer is unreachable — no number is
   *  returned (rows: []) rather than a fabricated one. The UI shows an honest outage. */
  unavailable?: boolean;
  /** LOUD degradation notice (Northpeak fix): requested slice members the view does not
   *  expose were dropped from the query — the result is NOT sliced as asked. */
  warning?: string;
  droppedMembers?: string[];
};

export async function exploreMetric(
  dataset: Dataset,
  measure: Measure,
  token: DelegatedToken,
  slice: { dimensions?: string[]; timeDimension?: string; granularity?: Granularity; limit?: number } = {},
  opts: {
    /** LEGACY flag from the Cube era: true when this measure is a pre-save draft. Since the
     *  metrics→Trino migration (Phase 1) EVERY metric read serves via governed Trino SQL —
     *  Cube is off the read path — so this no longer decides the read path (the SQL path is
     *  primary for saved + unsaved alike). Kept for call-site compatibility. */
    unsaved?: boolean;
  } = {},
): Promise<ExploreServerResult> {
  const spec = exploreSpec(dataset, measure, slice);
  const live = await liveMetricsReachable();
  // HONESTY GATE: on a real deployment, an unreachable Trino is an outage — return no
  // number (never the hash-seeded offline-mock, which is what surfaced fabricated KPIs
  // like 286,936). Local/teaching keeps the mock so the laptop flow still runs.
  if (!live && metricsMustBeLive()) {
    return {
      member: spec.member,
      rows: [],
      securityContext: {},
      sql: dropToSql(spec),
      mode: 'unavailable',
      unavailable: true,
      warning:
        'Metric temporarily unavailable — the governed lakehouse (Trino) is unreachable, so this number cannot be computed right now. No value is shown rather than an estimated one. Retry shortly; if it persists, the Trino service needs attention.',
    };
  }
  const base = {
    member: spec.member,
    sql: dropToSql(spec),
    mode: (live ? 'live' : 'offline-mock') as ExploreMode,
    // NEVER a silent de-dimension (Northpeak fix): members the view doesn't expose were
    // dropped from the query — say so on every result shape this function returns.
    ...(spec.dropped && spec.dropped.length > 0
      ? {
          droppedMembers: spec.dropped,
          warning: `Not sliced by ${spec.dropped.map((d) => `“${d}”`).join(', ')} — ${spec.dropped.length === 1 ? 'this member is' : 'these members are'} not exposed on the governed view (the dataset's domain table may need re-promotion, or the column isn't documented on the Gold).`,
        }
      : {}),
  };
  if (live) {
    // PRIMARY read path (metrics→Trino migration, Phase 1): compute the number as ONE
    // governed Trino SELECT over the TIER-AWARE physical gold mart, under the viewer's
    // delegated identity (R3 — Trino/OPA row/column security applies exactly as the working
    // "live (sql)" preview already did). Cube is off the metric read path — this serves saved
    // AND unsaved metrics alike, so a personal-dataset metric (read AS its owner from the
    // personal lane) now works. Honestly labelled 'live (sql)'.
    const identities = propagate(token); // throws if the token isn't user-delegated (R2/R3)
    const readTarget = goldReadTarget(dataset, token);
    const sql = previewTrinoSql(dataset, measure, spec, readTarget);
    if (!sql) {
      // No faithful SQL form for this slice. A rolling-window / running-total measure serves
      // as governed SQL (Phase 2) but REQUIRES a time dimension + granularity — a window with
      // no series, or an inexpressible trailing frame, has no honest number, so we return an
      // explicit pending with a clear reason rather than a fabricated value.
      const reason = measure.rollingWindow
        ? 'This is a rolling-window / running-total metric — add a time dimension and a matching granularity (e.g. day) to the slice so the trailing series can be computed.'
        : undefined;
      return {
        ...base,
        rows: [],
        securityContext: identities.cube.securityContext,
        pending: true,
        ...(reason ? { warning: reason } : {}),
      };
    }
    // Run AS the delegated token's SUBJECT (R3 — the viewer's uid). For a personal dataset the
    // subject owns the `personal_<uid>` schema (OPA `is_owned_personal`); for a governed
    // dataset the subject's groups carry the domain membership OPA gates the domain mart on.
    const result = await queryRun(sql, identities.trino.user);
    return {
      ...base,
      sql,
      mode: 'live (sql)',
      rows: sqlRowsToExploreRows(result.columns, result.rows, spec),
      securityContext: identities.cube.securityContext,
    };
  }
  // Not live: the honest offline-MOCK (local/teaching only — the honesty gate above already
  // returned 'unavailable' on a real deployment). Cube's in-memory mock enforces the same RLS.
  const result = await explore(spec, token, mockExecutor());
  return { ...base, rows: result.rows, securityContext: result.securityContext };
}
