/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../config.ts';
import { type DlsFilter, evaluateDls, type DocMeta } from './dls.ts';
import { cosine } from './embed.ts';

/**
 * The `files` hybrid index (deep-design A4 / B3). Each chunk is stored with its
 * dense vector + text + asset metadata, so retrieval can fuse **semantic** (k-NN
 * cosine) with **lexical/exact** (BM25-ish term overlap) — keeping exact-match for
 * names/IDs alongside semantic recall — and filter by the compiled **DLS**.
 *
 * Dual: the in-process index is authoritative in kind (and unit-tested); the
 * best-effort OpenSearch mirror (`ensureFilesIndex` / `bulkIndex` /
 * `liveHybridSearch`) makes a real deploy serve the SAME query from OpenSearch with
 * a k-NN mapping whose dimension comes from `config.filesEmbedDim` (never hardcoded).
 */

export type ChunkMeta = DocMeta & {
  name: string;
  deepLink: string;
  kind: string;
  tags: string[];
  freshness: string | null;
};

export type ChunkDoc = {
  fileId: string;
  chunkId: string;
  repType: string;
  text: string;
  hash: string;
  vector: number[];
  meta: ChunkMeta;
};

export type Hit = {
  fileId: string;
  chunkId: string;
  repType: string;
  text: string;
  score: number;
  semantic: number;
  lexical: number;
  meta: ChunkMeta;
};

// chunkId -> doc (the in-process authoritative index).
const index = new Map<string, ChunkDoc>();

export function __resetIndex(): void {
  index.clear();
}

/** Replace ALL of a file's chunks (a re-index). Returns the count indexed. */
export function indexFile(docs: ChunkDoc[], fileId: string): number {
  removeFromIndex(fileId);
  for (const d of docs) index.set(d.chunkId, d);
  return docs.length;
}

export function removeFromIndex(fileId: string): void {
  for (const [k, d] of index) if (d.fileId === fileId) index.delete(k);
}

/** The hashes already indexed for a file — the content-hash cache (skip re-embeds). */
export function indexedHashes(fileId: string): Set<string> {
  const hashes = new Set<string>();
  for (const d of index.values()) if (d.fileId === fileId) hashes.add(d.hash);
  return hashes;
}

/** Prior chunk vectors keyed by content hash — lets a re-index REUSE the vector of
 *  an unchanged chunk instead of re-embedding it (content-hash caching, A3). */
export function priorVectorsByHash(fileId: string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const d of index.values()) if (d.fileId === fileId) m.set(d.hash, d.vector);
  return m;
}

export function indexSize(): number {
  return index.size;
}

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Hybrid query over the in-process index: semantic (cosine) fused with lexical
 * (term overlap + exact-substring), filtered by the compiled DLS so only documents
 * the reader may see are returned. Returns chunk-level hits, top-k by fused score.
 * Phase 5 layers trust/freshness rerank + OPA + Langfuse on top of this.
 */
export function hybridQuery(opts: {
  queryVector: number[];
  queryText: string;
  filter: DlsFilter;
  k?: number;
}): Hit[] {
  const k = opts.k ?? 8;
  const q = opts.queryText.trim().toLowerCase();
  const qTokens = new Set(tokens(q));
  const hits: Hit[] = [];
  for (const d of index.values()) {
    if (!evaluateDls(opts.filter, d.meta)) continue; // DLS: only what the reader may see
    const semantic = cosine(opts.queryVector, d.vector);
    const hay = `${d.meta.name} ${d.text}`.toLowerCase();
    const docTokens = tokens(hay);
    let lexical = docTokens.filter((t) => qTokens.has(t)).length;
    if (q && hay.includes(q)) lexical += 3; // exact phrase / id / filename
    if (semantic <= 0 && lexical <= 0) continue;
    // Fuse: semantic recall + a damped lexical/exact signal.
    const score = semantic + lexical * 0.5;
    hits.push({ fileId: d.fileId, chunkId: d.chunkId, repType: d.repType, text: d.text, score, semantic, lexical, meta: d.meta });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

// ============================================================================
//  LIVE OpenSearch mirror (best-effort; a real deploy serves the same query)
//  Only invoked from the server pipeline; network-guarded, never blocks kind.
// ============================================================================

async function osFetch(path: string, init: RequestInit, ms = 4000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The `files` index mapping — a knn_vector whose dimension comes from config
 *  (templated from retrieval.knnDimension). PUT is idempotent-ish (best-effort). */
export function filesIndexMapping(dim = config.filesEmbedDim): Record<string, unknown> {
  return {
    settings: { index: { knn: true } },
    mappings: {
      properties: {
        file_id: { type: 'keyword' },
        rep_type: { type: 'keyword' },
        text: { type: 'text' },
        owner: { type: 'keyword' },
        tier: { type: 'keyword' },
        domain: { type: 'keyword' },
        granted_users: { type: 'keyword' },
        tags: { type: 'keyword' },
        freshness: { type: 'date' },
        vector: { type: 'knn_vector', dimension: dim },
      },
    },
  };
}

export async function ensureFilesIndex(): Promise<boolean> {
  const head = await osFetch(`/${config.filesIndex}`, { method: 'HEAD' });
  if (head && head.ok) return true;
  const res = await osFetch(`/${config.filesIndex}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filesIndexMapping()),
  });
  return Boolean(res && res.ok);
}

/** Bulk-index a file's chunks into OpenSearch (best-effort). */
export async function bulkIndex(docs: ChunkDoc[]): Promise<boolean> {
  if (docs.length === 0) return true;
  await ensureFilesIndex();
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(JSON.stringify({ index: { _index: config.filesIndex, _id: d.chunkId } }));
    lines.push(JSON.stringify({
      file_id: d.fileId, rep_type: d.repType, text: d.text,
      owner: d.meta.owner, tier: d.meta.tier, domain: d.meta.domain,
      granted_users: d.meta.grantedUsers, tags: d.meta.tags, freshness: d.meta.freshness, vector: d.vector,
    }));
  }
  const res = await osFetch(`/_bulk?refresh=true`, {
    method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: lines.join('\n') + '\n',
  });
  return Boolean(res && res.ok);
}

/** Build the OpenSearch hybrid query (knn + multi_match) with the DLS as a filter.
 *  Exported so Phase 5's retrieve can run it live (and so it is inspectable/testable). */
export function buildOpenSearchQuery(queryVector: number[], queryText: string, filter: DlsFilter, k = 8): Record<string, unknown> {
  return {
    size: k,
    _source: { excludes: ['vector'] },
    query: {
      bool: {
        must: [{
          bool: {
            should: [
              { multi_match: { query: queryText, fields: ['text^1.5', 'name'], type: 'best_fields', fuzziness: 'AUTO' } },
              { knn: { vector: { vector: queryVector, k } } },
            ],
            minimum_should_match: 1,
          },
        }],
        filter: [filter], // the compiled DLS — OpenSearch enforces it
      },
    },
  };
}
