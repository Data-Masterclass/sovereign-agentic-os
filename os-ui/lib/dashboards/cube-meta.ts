/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CubeMetaView } from '../infra/governed.ts';

/**
 * Narrow Cube's /meta to the caller's GOVERNED views (Tier 1 panel builder palette). Pure
 * so it is unit-tested on its own: given the members the caller can see (from listMetrics)
 * and Cube's /meta, it returns one entry per view the caller is entitled to — never a view
 * they can't see. A view Cube doesn't (yet) report falls back to the governed measures we
 * know from the registry, so the builder still works offline / before sidecar sync.
 */

export type PanelView = {
  view: string;
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  /** TRUE when Cube's /meta actually reports this view; FALSE when the palette fell back
   *  to the governed registry (Cube unreachable, sidecar lag, or — the Northpeak case — the
   *  dataset's domain table is missing/stale so Cube can't serve the view). An unserved
   *  view's members are still OFFERED (a chart is created WITH its spec, flagged at render),
   *  but the builder must WARN loudly — never silently empty the group-by palette. */
  served: boolean;
};

/** The view prefix of a governed metric member (`View.measure` → `View`). */
export function viewOfMember(member: string): string {
  const i = member.indexOf('.');
  return i > 0 ? member.slice(0, i) : member;
}

/** Registry-known dimension members per view — the fallback palette source when Cube
 *  does not serve a view (see `served` above). Built server-side from the governed
 *  dataset registry (`registryDimensionMembers`), keyed by view name. */
export type RegistryViewDims = Map<string, { dimensions: string[]; timeDimensions: string[] }>;

export function narrowCubeMeta(members: string[], meta: CubeMetaView[], registryDims?: RegistryViewDims): PanelView[] {
  const allowedViews = new Set<string>();
  const registryMeasures = new Map<string, Set<string>>();
  for (const member of members) {
    const view = viewOfMember(member);
    if (!view || view === '—') continue;
    allowedViews.add(view);
    if (!registryMeasures.has(view)) registryMeasures.set(view, new Set());
    registryMeasures.get(view)!.add(member);
  }
  const byName = new Map(meta.map((c) => [c.name, c]));
  return [...allowedViews].map((view) => {
    const live = byName.get(view);
    if (live) return { view, measures: live.measures, dimensions: live.dimensions, timeDimensions: live.timeDimensions, served: true };
    // Not served by Cube → fall back to the GOVERNED REGISTRY so the builder still offers
    // the real members (Northpeak fix: the group-by must never silently vanish from the
    // palette). `served: false` makes the degradation loud in the builder.
    const reg = registryDims?.get(view);
    return {
      view,
      measures: [...(registryMeasures.get(view) ?? [])],
      dimensions: reg?.dimensions ?? [],
      timeDimensions: reg?.timeDimensions ?? [],
      served: false,
    };
  });
}
