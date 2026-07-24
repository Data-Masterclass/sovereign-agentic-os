/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { cubeLoad } from '@/lib/infra/governed';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import { isCubeSyncLag, liveMetricsReachable } from '../../metrics/build/live-clients.ts';
import { type Panel, buildPanelCubeQuery, panelMetrics } from '../model.ts';

/**
 * Server boundary for a NATIVE dashboard panel (Tier 1). Resolves the panel's governed
 * Cube query UNDER THE VIEWER'S delegated identity (R3): {@link propagate} derives the
 * viewer's `securityContext`, {@link cubeLoad} forwards it as `x-cube-security-context`
 * so Cube's row-level security applies — two viewers of the SAME shared/certified
 * dashboard see DIFFERENT rows. Mirrors lib/metrics/build/explore-server.ts exactly:
 *   • LIVE Cube when reachable (RLS at Cube);
 *   • an honest offline-MOCK that itself filters by `securityContext.region`, so the
 *     "two viewers, different rows" guarantee holds on a laptop too;
 *   • Cube sidecar sync-lag (a just-defined metric not yet in Cube) degrades to a soft
 *     `pending` (200, no rows) — never a hard error or a blank panel.
 */

export type PanelQueryMode = 'live' | 'offline-mock';

export type PanelQueryResult = {
  rows: Record<string, unknown>[];
  mode: PanelQueryMode;
  /** True when Cube is up but the panel's measure hasn't sync'd yet (soft "syncing…"). */
  pending?: boolean;
  securityContext: Record<string, unknown>;
  /** The Cube `load` query body (for the developer surface + honest transparency). */
  sql: string;
};

/**
 * The offline-mock executor — a tiny region-partitioned table that ENFORCES the security
 * context exactly like Cube would, so the RLS demo is real offline. Deterministic value
 * per (member, region) so numbers are stable + agree with the metrics explorer mock.
 */
function mockRows(query: ReturnType<typeof buildPanelCubeQuery>, ctx: Record<string, unknown>): Record<string, unknown>[] {
  const REGIONS = ['DE', 'FR', 'US'];
  const valueOf = (member: string, region: string) => {
    const s = `${member}:${region}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h % 90000) + 10000;
  };
  const viewerRegion = ctx.region as string | undefined;
  const regions = viewerRegion ? REGIONS.filter((r) => r === viewerRegion) : REGIONS;
  const measures = query.measures ?? [];
  const regionDim = (query.dimensions ?? []).find((d) => d.endsWith('.region'));
  const timeDim = query.timeDimensions?.[0]?.dimension;
  const cell = (region: string) => Object.fromEntries(measures.map((m) => [m, valueOf(m, region)]));
  if (regionDim) {
    return regions.map((r) => ({ [regionDim]: r, ...cell(r) }));
  }
  if (timeDim) {
    // A tiny 3-point series so line/area panels have something honest to render offline.
    const months = ['2026-01-01', '2026-02-01', '2026-03-01'];
    return months.map((month, i) => {
      const total = regions.reduce((sum, r) => sum + valueOf(`${measures[0] ?? 'm'}:${month}:${i}`, r), 0);
      return { [timeDim]: month, ...Object.fromEntries(measures.map((m) => [m, total])) };
    });
  }
  // Scalar total across the viewer's entitled regions.
  const totals = Object.fromEntries(measures.map((m) => [m, regions.reduce((sum, r) => sum + valueOf(m, r), 0)]));
  return [totals];
}

/**
 * Run one panel's governed Cube query as the viewer. `token` is the viewer's delegated
 * token (R2/R3) — {@link propagate} asserts it is user-delegated and yields the RLS
 * security context. A panel with no metrics resolves to an empty result (nothing to chart).
 */
export async function runPanelQuery(view: string, panel: Panel, token: DelegatedToken): Promise<PanelQueryResult> {
  const { cube } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  const securityContext = cube.securityContext;
  const query = buildPanelCubeQuery(panel);
  const sql = JSON.stringify(query);
  // Void reference so `view` stays part of the honest signature (the panel's members already
  // encode the view; kept explicit so callers pass the bound view for future validation).
  void view;

  if (panelMetrics(panel).length === 0) {
    return { rows: [], mode: (await liveMetricsReachable()) ? 'live' : 'offline-mock', securityContext, sql };
  }

  const live = await liveMetricsReachable();
  if (!live) {
    return { rows: mockRows(query, securityContext), mode: 'offline-mock', securityContext, sql };
  }
  try {
    const { rows } = await cubeLoad(query, { securityContext });
    return { rows, mode: 'live', securityContext, sql };
  } catch (e) {
    // Sidecar sync lag: the measure isn't in Cube yet. Soft PENDING (no rows), never a 400.
    if (isCubeSyncLag(e)) return { rows: [], mode: 'live', pending: true, securityContext, sql };
    throw e;
  }
}
