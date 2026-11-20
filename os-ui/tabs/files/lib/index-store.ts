/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '@core/kernel/config';
import { opensearchFetch } from '@core/adapters/opensearch/client';
import { type DlsFilter, evaluateDls, toIndexDls, type DocMeta } from '@tabs/files/lib/dls';
import { cosine } from '@tabs/files/lib/embed';

/**
 * The `files` hybrid index (deep-design A4 / B3). Each chunk is stored with its
 * dense vector + text + asset metadata, so retrieval can fuse **semantic** (k-NN
 * cosine) with **lexical/exact** (BM25-ish term overlap) — keeping exact-match for
 * names/IDs alongside semantic recall — and filter by the compiled **DLS**.
 *
 * Dual: the in-process index is authoritative in kind (and unit-tested); the
 * best-effort OpenSearch mirror (`ensureFilesIndex` / `bulkIndex` /
 * `buildOpenSearchQuery`) makes a real deploy serve the SAME query from OpenSearch
 * with a k-NN mapping whose dimension comes from `config.filesEmbedDim` (never hardcoded).
 */

export type ChunkMeta = DocMeta & {
  name: string;
  deepLink: string;
  kind: string;
  tags: string[];
  /** The file's description (user-written or generated) — matched by the lexical half of search. */
  description?: string;
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
const FILE_INDEX_KEY = Symbol.for('soa.files.index');
function fileIndex(): Map<string, ChunkDoc> {
  const g = globalThis as unknown as Record<symbol, Map<string, ChunkDoc> | undefined>;
  if (!g[FILE_INDEX_KEY]) g[FILE_INDEX_KEY] = new Map();
  return g[FILE_INDEX_KEY]!;
}

export function __resetIndex(): void {
  fileIndex().clear();
}

/** Replace ALL of a file's chunks (a re-index). Returns the count indexed. */
export function indexFile(docs: ChunkDoc[], fileId: string): number {
  removeFromIndex(fileId);
  for (const d of docs) fileIndex().set(d.chunkId, d);
  return docs.length;
}

export function removeFromIndex(fileId: string): void {
  for (const [k, d] of fileIndex()) if (d.fileId === fileId) fileIndex().delete(k);
}

/** Prior chunk vectors keyed by content hash — lets a re-index REUSE the vector of
 *  an unchanged chunk instead of re-embedding it (content-hash caching, A3). */
export function priorVectorsByHash(fileId: string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const d of fileIndex().values()) if (d.fileId === fileId) m.set(d.hash, d.vector);
  return m;
}

export function indexSize(): number {
  return fileIndex().size;
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
  for (const d of fileIndex().values()) {
    if (!evaluateDls(opts.filter, d.meta)) continue; // DLS: only what the reader may see
    const semantic = cosine(opts.queryVector, d.vector);
    // Name, tags and description are matched alongside the passage — the same way whoever wrote them.
    const hay = `${d.meta.name} ${d.meta.tags.join(' ')} ${d.meta.description ?? ''} ${d.text}`.toLowerCase();
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
    return await opensearchFetch(path, { ...init, signal: ctrl.signal, timeoutMs: ms });
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
        // Read back by search (name is BM25-matched and shown; deep_link/kind label a hit).
        name: { type: 'text' },
        deep_link: { type: 'keyword' },
        kind: { type: 'keyword' },
        description: { type: 'text' },
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
      granted_users: d.meta.grantedUsers, tags: d.meta.tags, description: d.meta.description ?? '', freshness: d.meta.freshness, vector: d.vector,
      name: d.meta.name, deep_link: d.meta.deepLink, kind: d.meta.kind,
    }));
  }
  const res = await osFetch(`/_bulk?refresh=true`, {
    method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: lines.join('\n') + '\n',
  });
  return Boolean(res && res.ok);
}

/**
 * Remove a file's OpenSearch chunks EXCEPT the ones just written — the prune half of an
 * add-then-prune re-index (the admin re-index, 2026-11-19).
 *
 * Why this order and not delete-then-add: a re-parse can produce FEWER chunks than the index
 * holds (`<fileId>#0…#7` becomes `#0…#4`), so the surplus must go — but deleting first means a
 * failed bulk write leaves the file with NO rows at all, which is exactly "deleting a row it
 * could not replace". `bulkIndex` overwrites by `_id`, so adding first is idempotent and this
 * sweep only ever removes what the new write did not cover. Call it ONLY after `bulkIndex`
 * returned true, and never with an empty `keepIds` (that would be the delete-everything case this
 * function exists to make impossible — it refuses).
 *
 * Returns true when the delete-by-query was accepted; false when OpenSearch was unreachable or
 * refused, in which case the stale rows simply stay (honest, and harmless — they are duplicates
 * of content the new rows already carry, never the only copy).
 */
export async function pruneChunksExcept(fileId: string, keepIds: string[]): Promise<boolean> {
  if (keepIds.length === 0) return false; // never prune to nothing
  const body = {
    query: {
      bool: {
        must: [{ term: { file_id: fileId } }],
        must_not: [{ ids: { values: keepIds } }],
      },
    },
  };
  const res = await osFetch(`/${config.filesIndex}/_delete_by_query?refresh=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return Boolean(res && res.ok);
}

/**
 * Delete EVERY OpenSearch chunk of a file — the search half of a permanent delete. Live search
 * (`retrieve.ts`) reads this index directly, so a chunk left behind would keep quoting a deleted
 * file to every reader and agent. Awaited, with a bounded retry; a missing index (404) holds no
 * chunks and is a success. Returns what OpenSearch said, so the caller reports a leftover
 * honestly instead of assuming it is gone.
 */
export async function removeChunksFromMirror(fileId: string, opts: { attempts?: number; backoffMs?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 100;
  const body = JSON.stringify({ query: { term: { file_id: fileId } } });
  let reason = 'no answer';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * attempt));
    const res = await osFetch(`/${config.filesIndex}/_delete_by_query?refresh=true&conflicts=proceed`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    if (!res) { reason = 'no answer (network error or timeout)'; continue; }
    if (res.ok || res.status === 404) return { ok: true };
    reason = `HTTP ${res.status}`;
  }
  return { ok: false, reason: `the search index did not confirm the chunk delete (${reason}, ${attempts} attempts)` };
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
              { multi_match: { query: queryText, fields: ['text^1.5', 'name', 'tags', 'description'], type: 'best_fields', fuzziness: 'AUTO' } },
              { knn: { vector: { vector: queryVector, k } } },
            ],
            minimum_should_match: 1,
          },
        }],
        filter: [toIndexDls(filter)], // the compiled DLS, spelled with the index's field names
      },
    },
  };
}
