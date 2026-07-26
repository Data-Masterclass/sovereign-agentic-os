/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
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
 *  (the draft measure isn't in Cube yet), honestly labelled apart from Cube-served. */
export type ExploreMode = 'live' | 'live (sql)' | 'offline-mock';

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
  const base = { member: spec.member, sql: dropToSql(spec), mode: (live ? 'live' : 'offline-mock') as ExploreMode };
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
