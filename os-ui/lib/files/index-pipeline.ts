/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from './asset-schema.ts';
import { docMetaOf } from './dls.ts';
import { type IngestAdapter, type Chunk } from './ingest/types.ts';
import { liveAdapterFor } from './ingest/live.ts';
import { embedTexts } from './embed.ts';
import {
  type ChunkDoc,
  type ChunkMeta,
  indexFile,
  removeFromIndex,
  priorVectorsByHash,
  bulkIndex,
} from './index-store.ts';

/**
 * The auto-index pipeline (deep-design Flow A): ingest-by-type → chunk + hash →
 * embed (only NEW/changed chunks — content-hash cache) → write to the hybrid index.
 * It is the orchestration the status chip narrates: Processing → Extracting →
 * Indexing → Searchable ✓.
 *
 * Dual by composition: it uses the LIVE ingest adapter + LIVE embedder by default
 * (each of which self-falls-back to its deterministic mock when the service is off),
 * so the same code runs in kind and on a deploy. Tests inject the mock adapter +
 * embedder for determinism, and pass `live: false` to skip the OpenSearch mirror.
 */

export type IndexReport = {
  fileId: string;
  status: 'searchable' | 'stored-only' | 'empty';
  indexed: number;
  embedded: number;
  reusedFromCache: number;
  ingestMode: 'live' | 'mock' | 'n/a';
  embedMode: 'live' | 'mock' | 'n/a';
  representations: string[];
};

function metaOf(asset: FileAsset): ChunkMeta {
  return {
    ...docMetaOf(asset),
    name: asset.name,
    deepLink: asset.deepLink,
    kind: asset.kind,
    tags: asset.tags,
    freshness: asset.freshness,
  };
}

export async function indexAsset(
  asset: FileAsset,
  text: string,
  opts: { adapter?: IngestAdapter; embed?: typeof embedTexts; live?: boolean } = {},
): Promise<IndexReport> {
  // Stored-only opt-out (sensitive/huge / restricted): held but never indexed.
  if (asset.indexing.mode === 'stored-only') {
    removeFromIndex(asset.id); // drop any stale index if it was just opted out
    return { fileId: asset.id, status: 'stored-only', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: 'n/a', embedMode: 'n/a', representations: [] };
  }

  const adapter = opts.adapter ?? liveAdapterFor(asset.kind);
  const embed = opts.embed ?? embedTexts;

  const result = await adapter.apply({ fileId: asset.id, name: asset.name, kind: asset.kind, text, deepLink: asset.deepLink });
  if (!adapter.verify(result)) {
    removeFromIndex(asset.id);
    return { fileId: asset.id, status: 'empty', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: result.mode, embedMode: 'n/a', representations: [] };
  }

  // Flatten chunks across representations, tagging each with its representation type.
  const flat: { chunk: Chunk; repType: string }[] = [];
  for (const rep of result.representations) for (const chunk of rep.chunks) flat.push({ chunk, repType: rep.type });
  if (flat.length === 0) {
    removeFromIndex(asset.id);
    return { fileId: asset.id, status: 'empty', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: result.mode, embedMode: 'n/a', representations: result.representations.map((r) => r.type) };
  }

  // Content-hash cache: reuse the prior vector for any unchanged chunk; embed the rest.
  const prior = priorVectorsByHash(asset.id);
  const toEmbed: { idx: number; text: string }[] = [];
  const vectors: (number[] | null)[] = flat.map(({ chunk }, idx) => {
    const cached = prior.get(chunk.hash);
    if (cached) return cached;
    toEmbed.push({ idx, text: chunk.text });
    return null;
  });

  let embedMode: IndexReport['embedMode'] = 'n/a';
  if (toEmbed.length > 0) {
    const embedded = await embed(toEmbed.map((t) => t.text));
    embedMode = embedded.mode;
    toEmbed.forEach((t, i) => { vectors[t.idx] = embedded.vectors[i]; });
  }

  const meta = metaOf(asset);
  const docs: ChunkDoc[] = flat.map(({ chunk, repType }, idx) => ({
    fileId: asset.id, chunkId: chunk.id, repType, text: chunk.text, hash: chunk.hash,
    vector: vectors[idx] ?? [], meta,
  }));

  indexFile(docs, asset.id);
  if (opts.live) void bulkIndex(docs); // best-effort OpenSearch mirror on a real deploy

  return {
    fileId: asset.id,
    status: 'searchable',
    indexed: docs.length,
    embedded: toEmbed.length,
    reusedFromCache: flat.length - toEmbed.length,
    ingestMode: result.mode,
    embedMode,
    representations: result.representations.map((r) => r.type),
  };
}
