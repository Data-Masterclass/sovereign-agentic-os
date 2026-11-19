/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trace/lineage correlation — tie a signal to its run, pipeline, system and artifact
 * USER STORY: As a user looking at a failed run I want to reach the stale pipeline and data
 *             product behind it, and the related audit entry and cost cap, so that I can explain
 *             the failure end to end.
 * ARCHITECTURE:
 *   - Pure; exported via `index.ts` and used by `app/api/monitoring/correlate/route.ts`.
 *   - Relations are link tokens (an item's id plus every value in `links`); two items relate
 *     when their token sets intersect, so correlation works whichever side wrote the link.
 *   - Scope-safe: the component grows only through items `canSee` allows, so following a link
 *     never reveals an out-of-scope item. One item per lens is kept (anchor first, else worst).
 */
import type { HealthItem, Correlation, LensId, Scope } from '@tabs/monitoring/lib/types';
import { canSee } from '@tabs/monitoring/lib/scope-core';

function tokens(it: HealthItem): Set<string> {
  const t = new Set<string>([it.id]);
  for (const v of Object.values(it.links ?? {})) if (v) t.add(v);
  return t;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Build the correlation chain anchored on `anchorId`, growing the IN-SCOPE
 * connected component outward, then bucketing one item per lens (the anchor wins
 * its own lens; otherwise the worst-health member).
 */
export function correlate(scope: Scope, anchorId: string, items: HealthItem[]): Correlation | null {
  const anchor = items.find((it) => it.id === anchorId || it.links?.runId === anchorId);
  if (!anchor || !canSee(scope, anchor)) return null;

  const accepted: HealthItem[] = [anchor];
  const acceptedTokens = tokens(anchor);
  const pool = items.filter((it) => it !== anchor && canSee(scope, it));

  // Grow the component: pull any in-scope item whose tokens touch what we have.
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (intersects(tokens(pool[i]), acceptedTokens)) {
        const [it] = pool.splice(i, 1);
        accepted.push(it);
        for (const tk of tokens(it)) acceptedTokens.add(tk);
        grew = true;
      }
    }
  }

  const bucket = (lens: LensId): HealthItem | undefined => {
    const members = accepted.filter((it) => it.lens === lens);
    if (members.length === 0) return undefined;
    if (anchor.lens === lens) return anchor;
    // Prefer the most-attention-worthy (red > amber > green) of the lens.
    const rank: Record<string, number> = { red: 0, amber: 1, unknown: 2, green: 3 };
    return [...members].sort((a, b) => rank[a.health] - rank[b.health])[0];
  };

  // Cross-links: any audit/cap reference present anywhere in the component.
  const auditRef = accepted.map((it) => it.links?.auditRef).find(Boolean);
  const capRef = accepted.map((it) => it.links?.capRef).find(Boolean);

  return {
    anchor: anchor.lens,
    run: bucket('runs'),
    pipeline: bucket('pipelines'),
    system: bucket('system'),
    artifact: bucket('artifacts'),
    auditRef,
    capRef,
  };
}
