/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type KnowledgeUnit, type Provenance } from './chunk.ts';
import { roleAtLeast, type Role } from '../session.ts';

/**
 * Pure retrieval core — the parts that must be deterministic + unit-testable:
 *   • DLS (document-level security) GRANT FILTER — a query-time predicate so the
 *     retriever only ever returns units the principal may see (locked decision:
 *     query-time grant filter + OPA gate; real OpenSearch security-plugin deferred
 *     to STACKIT). Belt-and-suspenders with the OPA tool gate in retrieve.ts.
 *   • HYBRID score merge — combine a dense (cosine) score and a lexical (BM25-ish)
 *     score into one relevance score.
 *   • RERANK — relevance reweighted by trust + freshness + authority, so the most
 *     trustworthy, current, authoritative units float to the top-k.
 *
 * The server module (`retrieve.ts`) does the IO (OpenSearch / embeddings) and the
 * OPA gate; it calls these for the filtering + ranking so the logic is testable.
 */

export type Principal = { id: string; domains: string[]; role: Role };

/** DLS grant: can this principal see a unit with this provenance? (query-time). */
export function canSee(prov: Provenance, principal: Principal): boolean {
  // Marketplace units are discoverable by everyone.
  if (prov.visibility === 'Marketplace') return true;
  // Shared (or domain card) units are visible inside the owning domain.
  if (prov.visibility === 'Shared') return principal.domains.includes(prov.domain);
  // Personal/draft units: only the owner, or a Builder+ in the same domain.
  if (prov.owner === principal.id) return true;
  return roleAtLeast(principal.role, 'builder') && principal.domains.includes(prov.domain);
}

/** Apply the DLS filter to a unit list (the query-time grant filter). */
export function applyDls(units: KnowledgeUnit[], principal: Principal): KnowledgeUnit[] {
  return units.filter((u) => canSee(u.provenance, principal));
}

/** Lexical overlap score (0..1) — a cheap BM25 stand-in for the offline path. */
export function lexicalScore(query: string, text: string): number {
  const q = new Set(
    query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1),
  );
  if (q.size === 0) return 0;
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  let hits = 0;
  for (const w of words) if (q.has(w)) hits++;
  // Saturating: many matches → approaches 1.
  return hits === 0 ? 0 : Math.min(1, hits / (q.size + 2));
}

/** Hybrid relevance: blend dense (semantic) and lexical (exact-term) signals. */
export function hybridScore(dense: number, lexical: number, denseWeight = 0.6): number {
  return denseWeight * dense + (1 - denseWeight) * lexical;
}

/** Freshness in 0..1 from an ISO timestamp (decays ~linearly over a year). */
export function freshness(updatedAt: string, now = Date.now()): number {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.max(0, 1 - ageDays / 365);
}

export type Scored = {
  unit: KnowledgeUnit;
  relevance: number;
  /** Final rank score after trust/freshness/authority reweighting. */
  score: number;
};

/**
 * Rerank candidates by relevance reweighted with trust + freshness + authority.
 * Weights sum to 1; relevance dominates but the governance signals break ties and
 * promote trustworthy, current, authoritative units (research-grounded rerank).
 */
export function rerank(
  candidates: { unit: KnowledgeUnit; relevance: number }[],
  opts: { now?: number; weights?: { relevance: number; trust: number; freshness: number; authority: number } } = {},
): Scored[] {
  const w = opts.weights ?? { relevance: 0.55, trust: 0.2, freshness: 0.1, authority: 0.15 };
  const now = opts.now ?? Date.now();
  return candidates
    .map(({ unit, relevance }) => {
      const p = unit.provenance;
      const score =
        w.relevance * relevance +
        w.trust * p.trust +
        w.freshness * freshness(p.updatedAt, now) +
        w.authority * p.authority;
      return { unit, relevance, score };
    })
    .sort((a, b) => b.score - a.score);
}
