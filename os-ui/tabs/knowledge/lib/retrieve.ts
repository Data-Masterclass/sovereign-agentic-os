/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { opensearchTry } from '@core/adapters/opensearch/client';
import { roleAtLeast } from '@core/kernel/session';
import { authorize } from '@core/infra/agent-governed';
import { type KnowledgeUnit, type Provenance, type UnitType } from '@tabs/knowledge/lib/chunk';
import { embedQuery } from '@tabs/knowledge/lib/embed';
import { allUnits } from '@tabs/knowledge/lib/index-store';
import { cosine } from '@tabs/knowledge/lib/embed-core';
import { reciprocalRankFusion, maxFusedScore, l2ScoreForCosine } from '@core/kernel/rank-fusion';
import {
  type Principal,
  type Scored,
  applyDls,
  canSee,
  lexicalScore,
  hybridScore,
  rerank,
} from '@tabs/knowledge/lib/retrieve-core';

/**
 * The governed `knowledge` retrieval tool — the runtime read path. Belt-and-
 * suspenders governance: (1) the OPA tool GATE (authorize the principal for
 * `retrieve`; default-deny), and (2) the query-time DLS GRANT FILTER (only units
 * the principal may see). Then hybrid retrieve (dense cosine + lexical BM25-ish) →
 * rerank by trust/freshness/authority → top-k with provenance for citations.
 *
 * LIVE: OpenSearch hybrid query with the DLS filter pushed down (real
 * security-plugin DLS is deferred to STACKIT — here we add the grant filter to the
 * query AND re-check in code). OFFLINE: cosine + lexical over the in-process index.
 * Mirrors the dual pattern of `retrieveTool` / `guardrails-apply`.
 */

/** How the live candidates were fetched (for an honest report). */
export type RetrievalMode = 'hybrid' | 'bm25' | 'offline';

export type RetrieveResult = {
  decision: 'allow' | 'deny';
  policy: string;
  reason: string;
  store: 'opensearch' | 'memory';
  mode: RetrievalMode;
  embedSource: 'litellm' | 'offline-hash';
  hits: Scored[];
};

/** One OpenSearch call through the one client; `null` = unreachable or timed out. */
function osTry(path: string, init: RequestInit, ms = 4000): Promise<Response | null> {
  return opensearchTry(path, { ...init, timeoutMs: ms });
}

/** Build the DLS grant filter clauses (the query-time grant filter pushed to OS).
 *  Exported so the knowledge-docs listing route pushes down the IDENTICAL filter. */
export function dlsFilter(principal: Principal): Record<string, unknown> {
  const visible: Record<string, unknown>[] = [
    { term: { visibility: 'Marketplace' } },
    { bool: { must: [{ term: { visibility: 'Shared' } }, { terms: { domain: principal.domains } }] } },
    { term: { owner: principal.id } },
  ];
  if (roleAtLeast(principal.role, 'builder')) {
    // …but never a Personal NOTE: a note is its owner's only (`canSee`).
    visible.push({ bool: { must: [{ term: { visibility: 'Personal' } }, { terms: { domain: principal.domains } }], must_not: [{ term: { type: 'note' } }] } });
  }
  return { bool: { should: visible, minimum_should_match: 1 } };
}

function srcToUnit(id: string, src: Record<string, unknown>): KnowledgeUnit {
  const provenance: Provenance = {
    domain: String(src.domain ?? ''),
    workflowId: (src.workflow_id as string) ?? null,
    stepId: (src.step_id as string) ?? null,
    type: (src.type as UnitType) ?? 'workflow',
    actor: (src.actor as string) ?? null,
    owner: String(src.owner ?? ''),
    version: String(src.version ?? '1'),
    visibility: String(src.visibility ?? 'Personal'),
    updatedAt: String(src.updated_at ?? src.ingested_at ?? new Date().toISOString()),
    trust: typeof src.trust === 'number' ? src.trust : 0.5,
    authority: typeof src.authority === 'number' ? src.authority : 0.5,
  };
  return { id, title: String(src.title ?? id), text: String(src.text ?? ''), provenance };
}

type LiveHit = { id: string; score: number; src: Record<string, unknown> };

async function search(body: unknown): Promise<LiveHit[] | null> {
  const res = await osTry(`/${config.knowledgeIndex}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return null; // unreachable
  if (!res.ok) return null; // query rejected (e.g. knn on an unmapped field)
  try {
    const data = JSON.parse(await res.text());
    const hits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
    return hits.map((h: Record<string, unknown>) => ({ id: String(h._id ?? ''), score: Number(h._score ?? 0), src: (h._source ?? {}) as Record<string, unknown> }));
  } catch {
    return null;
  }
}

const bm25Clause = (query: string) => ({
  multi_match: { query, fields: ['title^2', 'text'], type: 'best_fields', fuzziness: 'AUTO' },
});

/**
 * LIVE: TRUE hybrid by fusion. BM25 (lexical) and k-NN (dense) run as TWO queries, each with the
 * DLS filter, and are fused by rank (RRF, `core/kernel/rank-fusion.ts`). A unit either list found
 * counts — a dense hit needs no keyword.
 *
 * Until 2026-11-20 this was ONE query with BM25 in `must` and k-NN in `should`: the keyword was a
 * precondition, so a passage that meant the question without using its words was never found; and
 * the caller then scored every live hit `hybridScore(0.5, lexical)`, discarding the dense signal.
 *
 * k-NN first tries the DLS as an EFFICIENT filter (inside the k-NN clause, so k stays k after
 * filtering); an engine that refuses that (400) gets a post-filtered k-NN with a wider k. No query
 * vector (gateway down, or a stand-in hash that has nothing to do with the stored real vectors) →
 * BM25 alone, `mode: 'bm25'`. Returns null when OpenSearch is unreachable or found nothing.
 */
async function retrieveLive(
  query: string,
  vector: number[] | null,
  principal: Principal,
  k: number,
): Promise<{ candidates: { unit: KnowledgeUnit; relevance: number }[]; mode: 'hybrid' | 'bm25' } | null> {
  const size = Math.max(k * 3, 12);
  const dls = dlsFilter(principal);
  const source = { excludes: ['embedding'] };

  const lexicalP = search({ size, _source: source, query: { bool: { must: [bm25Clause(query)], filter: [dls] } } });
  const denseP = vector
    ? (async () => {
        const filtered = await search({ size, _source: source, query: { knn: { embedding: { vector, k: size, filter: dls } } } });
        if (filtered) return filtered;
        return search({ size, _source: source, query: { bool: { must: [{ knn: { embedding: { vector, k: size * 4 } } }], filter: [dls] } } });
      })()
    : Promise.resolve(null);
  const [lexical, denseAll] = await Promise.all([lexicalP, denseP]);
  // k-NN returns the k nearest however unrelated; below the semantic floor a unit is not a match.
  const floor = l2ScoreForCosine(config.searchSemanticMinCosine);
  const dense = denseAll ? denseAll.filter((h) => h.score >= floor) : null;
  if (!lexical && !dense) return null;

  const units = new Map<string, KnowledgeUnit>();
  for (const h of [...(lexical ?? []), ...(dense ?? [])]) if (!units.has(h.id)) units.set(h.id, srcToUnit(h.id, h.src));
  if (units.size === 0) return null; // nothing indexed for this principal → the offline mirror

  const lists = [{ name: 'lexical', ids: (lexical ?? []).map((h) => h.id) }];
  if (dense) lists.push({ name: 'dense', ids: dense.map((h) => h.id) });
  const top = maxFusedScore(lists.length);
  const candidates = reciprocalRankFusion(lists).map((f) => ({ unit: units.get(f.id)!, relevance: f.score / top }));
  return { candidates, mode: dense ? 'hybrid' : 'bm25' };
}

/**
 * Retrieve grounded units for a query under a principal's identity. OPA gate first
 * (deny → no retrieval), then DLS grant filter, hybrid score, rerank, top-k.
 */
export async function retrieveKnowledge(
  query: string,
  principal: Principal,
  opts: { k?: number; workflowId?: string } = {},
): Promise<RetrieveResult> {
  const k = opts.k ?? 6;

  // (1) OPA tool gate — default-deny. Tool grants are keyed by DOMAIN (a uid has
  // no grant of its own), so gate on the caller's domain principal — the same
  // principal query_data authorizes on. (DLS row-filtering below still scopes by
  // the full principal.domains set.)
  const authz = await authorize(principal.domains[0] ?? principal.id, 'retrieve');
  if (authz.effect === 'deny') {
    return { decision: 'deny', policy: authz.policy, reason: authz.reason, store: 'memory', mode: 'offline', embedSource: 'offline-hash', hits: [] };
  }

  // (2) Embed the query (live model or offline hash). A3 review: the embedding is BILLED to the
  // acting principal (`user`/`domain:` tags, their scoped key when one exists) — a retrieval is
  // the user's spend, not the platform's.
  const { vector, source: embedSource } = await embedQuery(query, {
    userId: principal.id,
    domain: principal.domains[0],
    tab: 'knowledge',
  });

  // (3) Candidate set — live OpenSearch (adaptive hybrid, DLS pushed down), else offline mirror.
  let candidates: { unit: KnowledgeUnit; relevance: number }[];
  let store: 'opensearch' | 'memory';
  let mode: RetrievalMode;
  // A stand-in hash vector is never compared with the stored real vectors (it would rank by a hash).
  const live = await retrieveLive(query, embedSource === 'litellm' ? vector : null, principal, k);
  if (live) {
    store = 'opensearch';
    mode = live.mode;
    // Re-check DLS in code (belt-and-suspenders); relevance is the fused rank (lexical + dense).
    candidates = live.candidates
      .filter(({ unit }) => canSee(unit.provenance, principal))
      .filter(({ unit: u }) => !opts.workflowId || u.provenance.workflowId === opts.workflowId || u.provenance.type === 'domain');
  } else {
    store = 'memory';
    mode = 'offline';
    const pool = applyDls(allUnits(), principal).filter(
      (u) => !opts.workflowId || u.provenance.workflowId === opts.workflowId || u.provenance.type === 'domain',
    );
    candidates = pool.map((u) => {
      const dense = cosine(vector, (u as { embedding?: number[] }).embedding ?? []);
      const lexical = lexicalScore(query, `${u.title} ${u.text}`);
      return { unit: u, relevance: hybridScore(dense, lexical) };
    });
  }

  // (4) Rerank by relevance + trust + freshness + authority, take top-k.
  const ranked = rerank(candidates).slice(0, k);

  return { decision: 'allow', policy: authz.policy, reason: authz.reason, store, mode, embedSource, hits: ranked };
}

/** Convenience: is a unit visible to a principal (exposed for callers/tests). */
export { canSee };
