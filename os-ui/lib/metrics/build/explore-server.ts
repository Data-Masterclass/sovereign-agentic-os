/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { cubeLoad, queryRun } from '@/lib/infra/governed';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import type { Dataset, Measure } from '../../data/index.ts';
import {
  type CubeExecutor,
  type Granularity,
  dropToSql,
  explore,
  exploreSpec,
  previewTrinoSql,
  sqlRowsToExploreRows,
} from '../explorer.ts';
import { isCubeSyncLag, liveMetricsReachable } from './live-clients.ts';

/**
 * Server boundary for the metric explorer. Runs the explore query UNDER the viewer's
 * delegated identity (R3) against LIVE Cube when reachable (cubeLoad forwards the
 * securityContext so Cube's RLS applies), or an honest offline-MOCK that itself filters
 * by the viewer's `securityContext.region` — so the "two viewers see different rows"
 * guarantee holds on a laptop too, not just on the cluster. Returns the rows + the SQL
 * the analyst would drop to, labelled live/offline-mock.
 */

/** 'live (sql)' = the pre-save preview: the number came from a governed Trino query
 *  (the draft measure isn't in Cube yet), honestly labelled apart from Cube-served.
 *  'unavailable' = a REAL deployment whose Cube semantic layer is unreachable: we
 *  return NO number rather than a fabricated offline-mock one (see metricsMustBeLive). */
export type ExploreMode = 'live' | 'live (sql)' | 'offline-mock' | 'unavailable';

/**
 * On a real deployment (OS_PROFILE ≠ 'local') the Cube semantic layer is a required
 * backend — if it's unreachable that's an OUTAGE, and a metric must say so, never
 * fabricate a plausible number. The offline-mock resolver (a hash-seeded demo value)
 * is ONLY legitimate on the local/laptop teaching flow, where no cluster exists and
 * the mock is clearly a worked example. This gate is what stops a made-up 286,936
 * from being shown as if it were a real KPI.
 */
function metricsMustBeLive(): boolean {
  return config.deploymentProfile !== 'local';
}

/** The live executor: governed Cube load with the viewer's securityContext (R3 RLS). */
function liveExecutor(): CubeExecutor {
  return { load: (query, securityContext) => cubeLoad(query, { securityContext }).then((r) => ({ rows: r.rows })) };
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
    /** True when this measure is NOT yet persisted on the dataset (a pre-save draft):
     *  Cube cannot know the member (the sidecar only ships persisted metrics), so the
     *  preview runs as governed SQL through Trino instead — never a Cube query for a
     *  member that can't exist. Saved + delivered metrics keep the Cube path. */
    unsaved?: boolean;
  } = {},
): Promise<ExploreServerResult> {
  const spec = exploreSpec(dataset, measure, slice);
  const live = await liveMetricsReachable();
  // HONESTY GATE: on a real deployment, an unreachable Cube is an outage — return no
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
        'Metric temporarily unavailable — the governed semantic layer (Cube) is unreachable, so this number cannot be computed right now. No value is shown rather than an estimated one. Retry shortly; if it persists, the Cube service needs attention.',
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
  if (live && opts.unsaved) {
    // PRE-SAVE preview: compute the same number as ONE governed Trino SELECT over the
    // gold mart, under the viewer's delegated identity (R3 — Trino/OPA row security),
    // honestly labelled 'live (sql)'. After save/delivery the Cube path takes over.
    const identities = propagate(token); // throws if the token isn't user-delegated (R2/R3)
    const sql = previewTrinoSql(dataset, measure, spec);
    if (!sql) {
      // No faithful plain-SQL form (rolling window / running total): the value is
      // computed by Cube after Publish — honest pending, not a fabricated number.
      return { ...base, rows: [], securityContext: identities.cube.securityContext, pending: true };
    }
    const result = await queryRun(sql, identities.trino.user);
    return {
      ...base,
      sql,
      mode: 'live (sql)',
      rows: sqlRowsToExploreRows(result.columns, result.rows, spec),
      securityContext: identities.cube.securityContext,
    };
  }
  try {
    const result = await explore(spec, token, live ? liveExecutor() : mockExecutor());
    return { ...base, rows: result.rows, securityContext: result.securityContext };
  } catch (e) {
    // Sidecar sync lag: the measure isn't in Cube yet. Soft PENDING (200, no rows) so the
    // preview shows "syncing", never a scary 400. Any other error propagates as an error.
    if (isCubeSyncLag(e)) return { ...base, rows: [], securityContext: {}, pending: true };
    throw e;
  }
}
