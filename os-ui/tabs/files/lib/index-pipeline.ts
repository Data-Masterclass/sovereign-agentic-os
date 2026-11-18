/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from '@tabs/files/lib/asset-schema';
import { docMetaOf } from '@tabs/files/lib/dls';
import { type IngestAdapter, type Chunk } from '@tabs/files/lib/ingest/types';
import { liveAdapterFor } from '@tabs/files/lib/ingest/live';
import { embedTexts, type EmbedCaller } from '@tabs/files/lib/embed';
import {
  type ChunkDoc,
  type ChunkMeta,
  indexFile,
  removeFromIndex,
  priorVectorsByHash,
  bulkIndex,
} from '@tabs/files/lib/index-store';

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
  /** The chunk ids this run wrote — the keep-set an add-then-prune re-index needs. */
  chunkIds: string[];
  /** Did the OpenSearch mirror land? `null` = not awaited (the default fire-and-forget). */
  mirrored: boolean | null;
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

/**
 * ATTRIBUTION (checklist A27, closed in iteration 2): `opts.caller` is the user whose upload or
 * edit caused this index, so the embedding call bills THAT principal with `domain:` / `tab:` tags
 * rather than the platform's `user os-system` + `domain:platform`. The bootstrap sweep has no
 * acting user and deliberately passes none — it IS a platform action, and saying so is honest.
 */
export async function indexAsset(
  asset: FileAsset,
  text: string,
  opts: {
    adapter?: IngestAdapter;
    embed?: typeof embedTexts;
    live?: boolean;
    caller?: EmbedCaller;
    /**
     * Bypass the content-hash vector cache and embed EVERY chunk again (the admin re-index,
     * 2026-11-19). The cache is what makes an ordinary re-index cheap, and it is also what would
     * make a re-index pointless: an unchanged chunk's cached vector may be the very hash vector
     * the re-index was started to replace. Default false — only the re-index asks for this.
     */
    reembed?: boolean;
    /**
     * AWAIT the OpenSearch mirror and report whether it landed, instead of firing it off. The
     * upload path deliberately does not wait (a 4 s OpenSearch timeout must not slow an upload);
     * a re-index MUST, because it may only prune the stale rows once the new ones are really
     * there. Default false.
     */
    awaitMirror?: boolean;
  } = {},
): Promise<IndexReport> {
  // Stored-only opt-out (sensitive/huge / restricted): held but never indexed.
  if (asset.indexing.mode === 'stored-only') {
    removeFromIndex(asset.id); // drop any stale index if it was just opted out
    return { fileId: asset.id, status: 'stored-only', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: 'n/a', embedMode: 'n/a', representations: [], chunkIds: [], mirrored: null };
  }

  const adapter = opts.adapter ?? liveAdapterFor(asset.kind);
  const embed = opts.embed ?? embedTexts;

  const result = await adapter.apply({ fileId: asset.id, name: asset.name, kind: asset.kind, text, deepLink: asset.deepLink });
  if (!adapter.verify(result)) {
    removeFromIndex(asset.id);
    return { fileId: asset.id, status: 'empty', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: result.mode, embedMode: 'n/a', representations: [], chunkIds: [], mirrored: null };
  }

  // Flatten chunks across representations, tagging each with its representation type.
  const flat: { chunk: Chunk; repType: string }[] = [];
  for (const rep of result.representations) for (const chunk of rep.chunks) flat.push({ chunk, repType: rep.type });
  if (flat.length === 0) {
    removeFromIndex(asset.id);
    return { fileId: asset.id, status: 'empty', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: result.mode, embedMode: 'n/a', representations: result.representations.map((r) => r.type), chunkIds: [], mirrored: null };
  }

  // Content-hash cache: reuse the prior vector for any unchanged chunk; embed the rest.
  // `reembed` hands the cache an EMPTY prior set, so every chunk is embedded again. See the opt.
  const prior = opts.reembed ? new Map<string, number[]>() : priorVectorsByHash(asset.id);
  const toEmbed: { idx: number; text: string }[] = [];
  const vectors: (number[] | null)[] = flat.map(({ chunk }, idx) => {
    const cached = prior.get(chunk.hash);
    if (cached) return cached;
    toEmbed.push({ idx, text: chunk.text });
    return null;
  });

  let embedMode: IndexReport['embedMode'] = 'n/a';
  if (toEmbed.length > 0) {
    const embedded = await embed(toEmbed.map((t) => t.text), opts.caller);
    embedMode = embedded.mode;
    toEmbed.forEach((t, i) => { vectors[t.idx] = embedded.vectors[i]; });
  }

  const meta = metaOf(asset);
  const docs: ChunkDoc[] = flat.map(({ chunk, repType }, idx) => ({
    fileId: asset.id, chunkId: chunk.id, repType, text: chunk.text, hash: chunk.hash,
    vector: vectors[idx] ?? [], meta,
  }));

  indexFile(docs, asset.id);
  // Best-effort OpenSearch mirror on a real deploy. Fire-and-forget by default (an upload must
  // not wait on it); awaited only when the caller needs to know it landed — see `awaitMirror`.
  let mirrored: boolean | null = null;
  if (opts.live) {
    if (opts.awaitMirror) mirrored = await bulkIndex(docs);
    else void bulkIndex(docs);
  }

  return {
    fileId: asset.id,
    status: 'searchable',
    indexed: docs.length,
    embedded: toEmbed.length,
    reusedFromCache: flat.length - toEmbed.length,
    ingestMode: result.mode,
    embedMode,
    representations: result.representations.map((r) => r.type),
    chunkIds: docs.map((d) => d.chunkId),
    mirrored,
  };
}
