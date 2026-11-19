/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        core (shared by Files and Knowledge search)
 * FEATURE:    Reciprocal rank fusion — one ranked list out of a lexical and a semantic one
 * USER STORY: As someone searching my files or knowledge I want a passage that MEANS what I asked
 *             to be found even when it shares none of my words, and an exact-name match to stay
 *             on top — without one signal silently gating the other.
 * ARCHITECTURE:
 *   - RRF (Cormack et al., 2009): score(d) = Σ over lists of 1 / (k + rank_in_list(d)). A document
 *     only one list found still scores; nothing is a precondition for anything else.
 *   - Ranks, not raw scores: BM25 is unbounded and k-NN scores live on another scale, so adding
 *     them would let one dominate by accident. Ranks need no normalisation and no OpenSearch
 *     search pipeline (the `hybrid` query needs one created on the cluster).
 *   - Pure and tiny: no IO, deterministic ties (first list order, then id).
 */

/** The usual RRF constant; larger flattens the head of each list. */
export const RRF_K = 60;

/**
 * Fuse ranked id lists. Each list is best-first; duplicates inside one list count once (at
 * their best rank). Returns ids best-first with their fused score and which lists found them.
 */
export function reciprocalRankFusion(
  lists: { name: string; ids: string[] }[],
  k = RRF_K,
): { id: string; score: number; foundBy: string[] }[] {
  const acc = new Map<string, { score: number; foundBy: string[]; firstSeen: number }>();
  let seen = 0;
  for (const list of lists) {
    const ranked = new Set<string>();
    for (const id of list.ids) {
      if (!id || ranked.has(id)) continue;
      ranked.add(id);
      const rank = ranked.size; // 1-based
      const cur = acc.get(id) ?? { score: 0, foundBy: [], firstSeen: seen++ };
      cur.score += 1 / (k + rank);
      cur.foundBy.push(list.name);
      acc.set(id, cur);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstSeen - b[1].firstSeen || a[0].localeCompare(b[0]))
    .map(([id, v]) => ({ id, score: v.score, foundBy: v.foundBy }));
}

/** The best fused score `lists` lists could give (rank 1 in every one) — to scale into 0..1. */
export function maxFusedScore(lists: number, k = RRF_K): number {
  return lists / (k + 1);
}

/**
 * The k-NN `_score` that corresponds to a cosine similarity of `minCosine`, for the `files` and
 * `knowledge` indices as mapped (no `method` → the default `l2` space, where OpenSearch scores
 * 1 / (1 + d²) and, for unit-length embeddings, d² = 2 − 2·cos). Without a floor, k-NN always
 * returns the k nearest documents however unrelated, so every query would "match" something.
 * Verified against OpenSearch 3.1 (2026-11-20): [1,0] vs [0,1] scores 0.3333 = 1 / (3 − 2·0).
 */
export function l2ScoreForCosine(minCosine: number): number {
  const c = Math.max(-1, Math.min(1, Number.isFinite(minCosine) ? minCosine : 0));
  return 1 / (3 - 2 * c);
}
