/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { cubeLoad, cubeMeta } from '@/lib/infra/governed';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import { isCubeSyncLag, liveMetricsReachable } from '../../metrics/build/live-clients.ts';
import { type Panel, buildPanelCubeQuery, missingPanelMembers, panelMetrics } from '../model.ts';
import { viewOfMember } from '../cube-meta.ts';

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
  /** LOUD degradation notice (Northpeak fix): set when the panel requests members the
   *  SERVED Cube model does not expose — e.g. a group-by dimension that vanished because
   *  the dataset's domain table is missing/stale and needs re-promotion. The panel renders
   *  this warning instead of silently collapsing to a single un-grouped bar. */
  warning?: string;
  /** The members that did not resolve (drives the warning; useful for the dev surface). */
  missingMembers?: string[];
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

/** The honest degradation notice for members the served model lacks (Northpeak fix). */
export function missingMembersWarning(missing: string[]): string {
  const dims = missing.map((m) => `“${m}”`).join(', ');
  return (
    `${missing.length === 1 ? 'Member' : 'Members'} ${dims} ${missing.length === 1 ? 'is' : 'are'} not available ` +
    'in the served model — the dataset’s domain table may be missing or stale and need re-promotion. ' +
    'The chart is NOT silently un-grouped; fix the model to render it as designed.'
  );
}

/** Injectable seams so the missing-member guard is unit-testable without a live Cube. */
export type PanelQueryDeps = {
  reachable?: typeof liveMetricsReachable;
  load?: typeof cubeLoad;
  meta?: typeof cubeMeta;
};

/**
 * Run one panel's governed Cube query as the viewer. `token` is the viewer's delegated
 * token (R2/R3) — {@link propagate} asserts it is user-delegated and yields the RLS
 * security context. A panel with no metrics resolves to an empty result (nothing to chart).
 *
 * LOUD-DEGRADATION contract (Northpeak fix): before running live, the panel's requested
 * members are checked against the SERVED /meta model. A member the served model lacks —
 * the signature of a missing/stale domain table behind the Cube view — returns an explicit
 * `warning` + `missingMembers` (no rows), NEVER a silently de-dimensioned single-bar chart
 * and NEVER a forever-"syncing…" pending. Soft `pending` is reserved for GENUINE sidecar
 * sync lag: Cube errored "not found" but /meta doesn't (yet) contradict the panel.
 */
export async function runPanelQuery(
  view: string,
  panel: Panel,
  token: DelegatedToken,
  deps: PanelQueryDeps = {},
): Promise<PanelQueryResult> {
  const { cube } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  const securityContext = cube.securityContext;
  const query = buildPanelCubeQuery(panel);
  const sql = JSON.stringify(query);
  const reachable = deps.reachable ?? liveMetricsReachable;
  const load = deps.load ?? cubeLoad;
  const meta = deps.meta ?? cubeMeta;
  // Void reference so `view` stays part of the honest signature (the panel's members already
  // encode the view; kept explicit so callers pass the bound view for future validation).
  void view;

  if (panelMetrics(panel).length === 0) {
    return { rows: [], mode: (await reachable()) ? 'live' : 'offline-mock', securityContext, sql };
  }

  const live = await reachable();
  if (!live) {
    return { rows: mockRows(query, securityContext), mode: 'offline-mock', securityContext, sql };
  }

  // The served-model guard: resolve what Cube ACTUALLY serves for this panel's view(s).
  // `served === null` ⇒ /meta unreachable/empty — we can't judge, so don't (fail open to
  // the query; the sync-lag catch below still applies). A served view missing members ⇒ LOUD.
  const servedViews = await meta().catch(() => []);
  const wanted = new Set(panelMetrics(panel).map(viewOfMember));
  const relevant = servedViews.filter((c) => wanted.has(c.name));
  if (servedViews.length > 0) {
    const served = {
      measures: relevant.flatMap((c) => c.measures),
      dimensions: relevant.flatMap((c) => c.dimensions),
      timeDimensions: relevant.flatMap((c) => c.timeDimensions),
    };
    const missing = missingPanelMembers(panel, served);
    if (missing.length > 0) {
      return {
        rows: [],
        mode: 'live',
        warning: missingMembersWarning(missing),
        missingMembers: missing,
        securityContext,
        sql,
      };
    }
  }

  try {
    const { rows } = await load(query, { securityContext });
    return { rows, mode: 'live', securityContext, sql };
  } catch (e) {
    // Sidecar sync lag: the measure isn't in Cube yet. Soft PENDING (no rows), never a 400.
    // (A PERMANENTLY missing member was already caught above by the served-model guard.)
    if (isCubeSyncLag(e)) return { rows: [], mode: 'live', pending: true, securityContext, sql };
    throw e;
  }
}
