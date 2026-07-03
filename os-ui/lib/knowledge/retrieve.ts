/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { authorize } from '@/lib/agent-governed';
import { type KnowledgeUnit, type Provenance, type UnitType } from './chunk.ts';
import { embedQuery } from './embed.ts';
import { allUnits } from './index-store.ts';
import { cosine } from './embed-core.ts';
import {
  type Principal,
  type Scored,
  applyDls,
  canSee,
  lexicalScore,
  hybridScore,
  rerank,
} from './retrieve-core.ts';

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

async function withTimeout(url: string, init: RequestInit, ms = 4000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Build the DLS grant filter clauses (the query-time grant filter pushed to OS).
 *  Exported so the knowledge-docs listing route pushes down the IDENTICAL filter. */
export function dlsFilter(principal: Principal): Record<string, unknown> {
  const visible: Record<string, unknown>[] = [
    { term: { visibility: 'Marketplace' } },
    { bool: { must: [{ term: { visibility: 'Shared' } }, { terms: { domain: principal.domains } }] } },
    { term: { owner: principal.id } },
  ];
  if (principal.role === 'builder' || principal.role === 'admin') {
    visible.push({ bool: { must: [{ term: { visibility: 'Personal' } }, { terms: { domain: principal.domains } }] } });
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

type LiveHit = { id: string; src: Record<string, unknown> };

async function search(body: unknown): Promise<LiveHit[] | null> {
  const res = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return null; // unreachable
  if (!res.ok) return null; // query rejected (e.g. knn on an unmapped field)
  try {
    const data = JSON.parse(await res.text());
    const hits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
    return hits.map((h: Record<string, unknown>) => ({ id: String(h._id ?? ''), src: (h._source ?? {}) as Record<string, unknown> }));
  } catch {
    return null;
  }
}

const bm25Clause = (query: string) => ({
  multi_match: { query, fields: ['title^2', 'text'], type: 'best_fields', fuzziness: 'AUTO' },
});

/**
 * LIVE: ADAPTIVE hybrid. Issue a true knn (dense) + BM25 (lexical) query when the
 * index has the `knn_vector` mapping (the chart provides it on STACKIT, dim from
 * `retrieval.knnDimension`); if that query is REJECTED (bare kind OpenSearch with
 * no vector field) fall back to BM25-only. Returns the units + which mode ran, or
 * null when OpenSearch is unreachable / has nothing indexed.
 */
async function retrieveLive(
  query: string,
  vector: number[],
  principal: Principal,
  k: number,
): Promise<{ units: KnowledgeUnit[]; mode: 'hybrid' | 'bm25' } | null> {
  const size = Math.max(k * 3, 12);
  const filter = [dlsFilter(principal)];

  // 1) Try true hybrid: knn (dense) + BM25 (lexical), DLS pushed down.
  const hybridBody = {
    size,
    _source: { excludes: ['embedding'] },
    query: {
      bool: {
        must: [bm25Clause(query)],
        should: [{ knn: { embedding: { vector, k: size } } }],
        filter,
      },
    },
  };
  const hybrid = await search(hybridBody);
  if (hybrid && hybrid.length > 0) {
    return { units: hybrid.map((h) => srcToUnit(h.id, h.src)), mode: 'hybrid' };
  }

  // 2) Fall back to BM25-only (the vector field isn't mapped, or hybrid was empty).
  const bm25Body = {
    size,
    _source: { excludes: ['embedding'] },
    query: { bool: { must: [bm25Clause(query)], filter } },
  };
  const bm25 = await search(bm25Body);
  if (bm25 && bm25.length > 0) {
    return { units: bm25.map((h) => srcToUnit(h.id, h.src)), mode: 'bm25' };
  }

  return null; // unreachable or nothing indexed → caller uses the offline mirror
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

  // (1) OPA tool gate — default-deny. A denied principal gets NO retrieval.
  const authz = await authorize(principal.id, 'retrieve');
  if (authz.effect === 'deny') {
    return { decision: 'deny', policy: authz.policy, reason: authz.reason, store: 'memory', mode: 'offline', embedSource: 'offline-hash', hits: [] };
  }

  // (2) Embed the query (live model or offline hash).
  const { vector, source: embedSource } = await embedQuery(query);

  // (3) Candidate set — live OpenSearch (adaptive hybrid, DLS pushed down), else offline mirror.
  let candidates: { unit: KnowledgeUnit; relevance: number }[];
  let store: 'opensearch' | 'memory';
  let mode: RetrievalMode;
  const live = await retrieveLive(query, vector, principal, k);
  if (live) {
    store = 'opensearch';
    mode = live.mode;
    // Re-check DLS in code (belt-and-suspenders) + score lexically.
    candidates = applyDls(live.units, principal)
      .filter((u) => !opts.workflowId || u.provenance.workflowId === opts.workflowId || u.provenance.type === 'domain')
      .map((unit) => ({ unit, relevance: hybridScore(0.5, lexicalScore(query, `${unit.title} ${unit.text}`)) }));
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
