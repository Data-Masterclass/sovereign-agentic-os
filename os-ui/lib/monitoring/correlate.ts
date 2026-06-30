/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { HealthItem, Correlation, LensId, Scope } from './types.ts';
import { canSee } from './scope-core.ts';

/**
 * TRACE/LINEAGE CORRELATION (the Opus core). Ties a signal back through the chain
 *   run  ↔  pipeline  ↔  system  ↔  artifact
 * and surfaces the Governance cross-links (→ audit entry, → cost cap). This is
 * what turns five separate lenses into one explainable story: from a failed run
 * you reach the stale pipeline, the OOMKilled pod that self-healed, and the stale
 * data product it produced — and equally, from the pipeline you reach the run.
 *
 * The relationships are link TOKENS, not directed pointers: each item exposes a
 * token set (its own id + every value in `links`). Two items are related when
 * their token sets intersect, so correlation is bidirectional regardless of which
 * side authored the link (a run points at its pipeline; the pipeline need not
 * point back). On a live cluster the tokens come from Langfuse trace metadata +
 * OpenMetadata lineage + the Governance audit/cap ids; offline from the fixtures.
 *
 * SCOPE-SAFE: the component is grown only through items the viewer may see, so
 * correlation can never leak a node/pipeline/artifact out of scope (e.g. a User
 * following a link must still own — or their Builder domain must cover — each hop).
 */

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
