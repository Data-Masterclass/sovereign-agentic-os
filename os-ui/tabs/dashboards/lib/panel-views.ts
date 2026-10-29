/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Tier-1 panel builder PALETTE, scoped to the caller's governed views. Every panel is
 * SERVED as governed SQL resolved through the metrics REGISTRY — so the registry is the
 * ONE palette source: what it offers is exactly what the executor can compute. Pure +
 * unit-tested: given the members the caller can see (from listMetrics), one entry per
 * entitled view — never a view they can't see.
 */

export type PanelView = {
  view: string;
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  /** Always TRUE — panels serve as governed SQL from the registry, so every entitled
   *  view is servable. Kept for response-shape compatibility. */
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

export function panelViewsFor(members: string[], registryDims?: RegistryViewDims): PanelView[] {
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
  // registry, so palette == executor capability by construction.
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
