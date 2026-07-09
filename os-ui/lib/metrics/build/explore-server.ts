/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { cubeLoad } from '@/lib/infra/governed';
import { type DelegatedToken } from '../../data/identity.ts';
import type { Dataset, Measure } from '../../data/dataset-schema.ts';
import { type CubeExecutor, type Granularity, dropToSql, explore, exploreSpec } from '../explorer.ts';
import { liveMetricsReachable } from './live-clients.ts';

/**
 * Server boundary for the metric explorer. Runs the explore query UNDER the viewer's
 * delegated identity (R3) against LIVE Cube when reachable (cubeLoad forwards the
 * securityContext so Cube's RLS applies), or an honest offline-MOCK that itself filters
 * by the viewer's `securityContext.region` — so the "two viewers see different rows"
 * guarantee holds on a laptop too, not just on the cluster. Returns the rows + the SQL
 * the analyst would drop to, labelled live/offline-mock.
 */

export type ExploreMode = 'live' | 'offline-mock';

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
};

export async function exploreMetric(
  dataset: Dataset,
  measure: Measure,
  token: DelegatedToken,
  slice: { dimensions?: string[]; timeDimension?: string; granularity?: Granularity; limit?: number } = {},
): Promise<ExploreServerResult> {
  const spec = exploreSpec(dataset, measure, slice);
  const live = await liveMetricsReachable();
  const result = await explore(spec, token, live ? liveExecutor() : mockExecutor());
  return { member: result.member, rows: result.rows, securityContext: result.securityContext, sql: dropToSql(spec), mode: live ? 'live' : 'offline-mock' };
}
