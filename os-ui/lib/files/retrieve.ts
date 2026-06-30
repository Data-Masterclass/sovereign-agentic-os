/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { authorize, trace } from '@/lib/agent-governed';
import { compileDls, type Reader } from '@/lib/files/dls';
import { embedQuery } from '@/lib/files/embed';
import { hybridQuery, buildOpenSearchQuery, type Hit, type ChunkMeta } from '@/lib/files/index-store';
import { bootstrapFilesIndex } from '@/lib/files/pipeline-server';
import { assertDelegated, rerank, toPassages, type FilePassage } from '@/lib/files/retrieve-rank';

/**
 * The agent `files_retrieve` tool (Files golden path §5 / deep-design Flow B). It
 * runs under the user's DELEGATED identity (never a service account), is OPA-gated
 * (`files_retrieve`), retrieves hybrid (BM25 + k-NN, neural-sparse on a live
 * cluster) over the `files` index FILTERED by the compiled DLS, reranks by
 * trust/freshness/authority, and returns cited passages (text/transcript/caption)
 * with the original openable on demand. Every call is Langfuse-traced.
 *
 * Dual: live it queries OpenSearch with the DLS as an OpenSearch filter; offline it
 * queries the in-process hybrid index with the SAME compiled DLS — identical policy.
 */

export type RetrieveResult = {
  decision: 'allow' | 'deny';
  policy: string;
  reason?: string;
  query: string;
  passages: FilePassage[];
  retrievalMode: 'opensearch' | 'in-process';
  embedMode: 'live' | 'mock';
  traceId: string;
};

async function liveSearch(queryVector: number[], queryText: string, filter: ReturnType<typeof compileDls>, k: number): Promise<Hit[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.opensearchUrl}/${config.filesIndex}/_search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: ctrl.signal,
      body: JSON.stringify(buildOpenSearchQuery(queryVector, queryText, filter, k)),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { hits?: { hits?: { _id: string; _score: number; _source: Record<string, unknown> }[] } };
    const hits = json.hits?.hits ?? [];
    if (hits.length === 0) return null;
    return hits.map((h) => {
      const s = h._source;
      const meta: ChunkMeta = {
        owner: String(s.owner ?? ''), tier: (s.tier as ChunkMeta['tier']) ?? 'dataset', domain: String(s.domain ?? ''),
        grantedUsers: Array.isArray(s.granted_users) ? (s.granted_users as string[]) : [],
        name: String(s.name ?? s.file_id ?? ''), deepLink: String(s.deep_link ?? ''), kind: String(s.kind ?? 'doc'),
        tags: Array.isArray(s.tags) ? (s.tags as string[]) : [], freshness: (s.freshness as string) ?? null,
      };
      return { fileId: String(s.file_id ?? h._id), chunkId: h._id, repType: String(s.rep_type ?? 'text'), text: String(s.text ?? ''), score: h._score, semantic: h._score, lexical: 0, meta };
    });
  } catch {
    return null; // OpenSearch off → caller uses the in-process index
  } finally {
    clearTimeout(timer);
  }
}

export async function filesRetrieve(input: {
  /** The DELEGATED user — drives the row-level DLS (which files they may see). */
  principal: Reader;
  /** The OPA tool-grant subject (the agent or the user's domain). Defaults to the
   *  user's first domain — the data spine grants `files_retrieve` by domain/agent. */
  grantSubject?: string;
  query: string;
  k?: number;
  openOriginal?: boolean;
  visionFlag?: boolean;
}): Promise<RetrieveResult> {
  // 1) Delegated identity — never a service account (R2).
  assertDelegated(input.principal);
  const k = input.k ?? 6;
  const query = input.query.trim();
  const subject = input.grantSubject ?? input.principal.domains[0] ?? input.principal.id;

  // 2) OPA gate (default-deny) on the tool-grant subject (agent/domain).
  const authz = await authorize(subject, 'files_retrieve');
  if (authz.effect === 'deny') {
    const tr = await trace({ principal: subject, tool: 'files_retrieve', input: { query }, output: { denied: authz.reason }, decision: 'deny' });
    return { decision: 'deny', policy: authz.policy, reason: authz.reason, query, passages: [], retrievalMode: 'in-process', embedMode: 'mock', traceId: tr.id };
  }

  // 3) Make sure the index is warm (seeds + anything uploaded before it existed).
  await bootstrapFilesIndex();

  // 4) Embed the query + compile the DLS from the delegated identity.
  const { vector, mode: embedMode } = await embedQuery(query);
  const filter = compileDls(input.principal);

  // 5) Hybrid retrieve — live OpenSearch (DLS as a filter) or the in-process index.
  const live = await liveSearch(vector, query, filter, k * 2);
  const retrievalMode: RetrieveResult['retrievalMode'] = live ? 'opensearch' : 'in-process';
  const hits = live ?? hybridQuery({ queryVector: vector, queryText: query, filter, k: k * 2 });

  // 6) Rerank by trust/freshness/authority → cited passages (open-original on demand).
  const ranked = rerank(hits, input.principal).slice(0, k);
  const passages = toPassages(ranked, { openOriginal: input.openOriginal, visionFlag: input.visionFlag });

  // 7) Langfuse trace (provenance + what was retrieved).
  const tr = await trace({
    principal: subject, tool: 'files_retrieve',
    input: { query, k, delegatedUser: input.principal.id }, output: { count: passages.length, files: passages.map((p) => p.name) },
    decision: 'allow', costUsd: 0.0006,
  });

  return { decision: 'allow', policy: authz.policy, query, passages, retrievalMode, embedMode, traceId: tr.id };
}
