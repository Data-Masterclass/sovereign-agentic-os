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
};

/** The view prefix of a governed metric member (`View.measure` → `View`). */
export function viewOfMember(member: string): string {
  const i = member.indexOf('.');
  return i > 0 ? member.slice(0, i) : member;
}

export function narrowCubeMeta(members: string[], meta: CubeMetaView[]): PanelView[] {
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
    if (live) return { view, measures: live.measures, dimensions: live.dimensions, timeDimensions: live.timeDimensions };
    return { view, measures: [...(registryMeasures.get(view) ?? [])], dimensions: [], timeDimensions: [] };
  });
}
