/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CubeMetaView } from '../infra/governed.ts';

/**
 * The Tier-1 panel builder PALETTE, scoped to the caller's governed views. Since the
 * metrics→Trino migration (Phase 2) every panel is SERVED as governed SQL resolved
 * through the metrics REGISTRY — so the registry is the ONE palette source: what it
 * offers is exactly what the executor can compute. Cube's /meta no longer decides
 * anything here (it only serves the Power BI bridge until Phase 3 removes it) — the
 * old "is Cube serving this view?" distinction is gone, and with it the false
 * "Cube is not serving X" warning on perfectly renderable panels. Pure + unit-tested:
 * given the members the caller can see (from listMetrics), one entry per entitled
 * view — never a view they can't see.
 */

export type PanelView = {
  view: string;
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  /** Always TRUE since Phase 2 — panels serve as governed SQL from the registry, so
   *  every entitled view is servable. Kept for response-shape compatibility. */
  served: boolean;
};

/** The view prefix of a governed metric member (`View.measure` → `View`). */
export function viewOfMember(member: string): string {
  const i = member.indexOf('.');
  return i > 0 ? member.slice(0, i) : member;
}

/** Registry-known dimension members per view — THE palette source. Built server-side
 *  from the governed dataset registry (`registryDimensionMembers`, join-aware via
 *  goldOutputColumns), keyed by view name. */
export type RegistryViewDims = Map<string, { dimensions: string[]; timeDimensions: string[] }>;

export function narrowCubeMeta(members: string[], _meta: CubeMetaView[], registryDims?: RegistryViewDims): PanelView[] {
  const allowedViews = new Set<string>();
  const registryMeasures = new Map<string, Set<string>>();
  for (const member of members) {
    const view = viewOfMember(member);
    if (!view || view === '—') continue;
    allowedViews.add(view);
    if (!registryMeasures.has(view)) registryMeasures.set(view, new Set());
    registryMeasures.get(view)!.add(member);
  }
  // Registry-only, deliberately: the SQL executor resolves panels through the SAME
  // registry, so palette == executor capability by construction (`_meta` is ignored
  // and kept only for call-site compatibility until Phase 3 deletes it).
  return [...allowedViews].map((view) => {
    const reg = registryDims?.get(view);
    return {
      view,
      measures: [...(registryMeasures.get(view) ?? [])],
      dimensions: reg?.dimensions ?? [],
      timeDimensions: reg?.timeDimensions ?? [],
      served: true,
    };
  });
}
