/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from '@tabs/files/lib/asset-schema';
import { docMetaOf } from '@tabs/files/lib/dls';
import { type IngestAdapter, type Chunk } from '@tabs/files/lib/ingest/types';
import { liveAdapterFor } from '@tabs/files/lib/ingest/live';
import { embedTexts, type EmbedCaller } from '@tabs/files/lib/embed';
import { refuseOfflineMock, OfflineMockRefusedError } from '@core/kernel/offline-mock';
import { recordIndexOutcome } from '@tabs/files/lib/store';
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
 * REQUIRE-LIVE (2026-11-19, re-index review M1). The honesty check used to live in the CALLER: the
 * re-index read `ingestMode`/`embedMode` off the report it got back — which is one statement too
 * late, because by then this function had already written the in-process index and awaited the
 * OpenSearch mirror. On a deployment that permits a stand-in (`OS_OFFLINE_MOCK=allow`) a parser
 * or gateway that fell over MID-RUN would therefore have overwritten good rows with placeholder
 * text and hash vectors, and the re-index would then have pruned around them. So the demand moved
 * INTO the pipeline: with `requireLive`, anything but a live parse and a live embedding is a typed
 * refusal raised BEFORE `indexFile` and BEFORE `bulkIndex`. Nothing is written at all.
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
    description: asset.description,
    freshness: asset.freshness,
  };
}

/**
 * ATTRIBUTION (checklist A27, closed in iteration 2): `opts.caller` is the user whose upload or
 * edit caused this index, so the embedding call bills THAT principal with `domain:` / `tab:` tags
 * rather than the platform's `user os-system` + `domain:platform`. The bootstrap sweep has no
 * acting user and deliberately passes none — it IS a platform action, and saying so is honest.
 */
export type IndexOpts = {
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
  /**
   * Refuse (typed `ENGINE_UNAVAILABLE`) instead of indexing anything when the parse or the
   * embedding came back as a stand-in. The re-index sets it: a re-index that accepted a
   * stand-in would rewrite the very rows it exists to replace. Default false — an ordinary
   * upload on a laptop keeps its honestly-labelled offline path.
   */
  requireLive?: boolean;
  /**
   * Keep the file's existing index rows when this run produced nothing indexable, instead of
   * dropping them (review M2). The re-index sets it, because "the parse produced nothing" is a
   * reason to leave the old rows alone, not to delete them — only a stored-only opt-out and a
   * genuine re-index of real content should ever remove rows.
   */
  keepOnEmpty?: boolean;
};

/**
 * Index one file, and RECORD what happened on the file (`indexing.outcome`), so the status chip
 * says "Searchable" only when the rows were really written. Recorded here, once, rather than in
 * each caller, so every door (upload, edit, connector sync, extraction, the boot sweep, the admin
 * re-index) is covered. Two cases leave the record alone because they leave the old rows alone:
 * a `requireLive` refusal (nothing written) and an empty run under `keepOnEmpty`.
 */
export async function indexAsset(asset: FileAsset, text: string, opts: IndexOpts = {}): Promise<IndexReport> {
  let report: IndexReport;
  try {
    report = await runIndex(asset, text, opts);
  } catch (e) {
    if (!(opts.requireLive && e instanceof OfflineMockRefusedError)) {
      recordIndexOutcome(asset.id, { status: 'failed', at: new Date().toISOString(), reason: (e as Error)?.message ?? String(e) });
    }
    throw e;
  }
  if (report.status === 'searchable') {
    recordIndexOutcome(asset.id, { status: 'indexed', at: new Date().toISOString(), chunks: report.indexed });
  } else if (report.status === 'empty' && !opts.keepOnEmpty) {
    recordIndexOutcome(asset.id, { status: 'empty', at: new Date().toISOString() });
  }
  return report;
}

async function runIndex(asset: FileAsset, text: string, opts: IndexOpts): Promise<IndexReport> {
  // Stored-only opt-out (sensitive/huge / restricted): held but never indexed.
  if (asset.indexing.mode === 'stored-only') {
    removeFromIndex(asset.id); // drop any stale index if it was just opted out
    return { fileId: asset.id, status: 'stored-only', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: 'n/a', embedMode: 'n/a', representations: [], chunkIds: [], mirrored: null };
  }

  const adapter = opts.adapter ?? liveAdapterFor(asset.kind);
  const embed = opts.embed ?? embedTexts;

  const result = await adapter.apply({ fileId: asset.id, name: asset.name, kind: asset.kind, text, deepLink: asset.deepLink });
  // REQUIRE-LIVE, first half: refuse on a stand-in PARSE before anything is removed or written.
  if (opts.requireLive && result.mode !== 'live') {
    refuseOfflineMock(
      `Cannot re-index “${asset.name}”: the parser answered with a stand-in (${result.mode}) ` +
        'rather than a real parse, so its placeholder text would have replaced the file’s indexed ' +
        'content. Nothing was written, removed or pruned.',
    );
  }
  if (!adapter.verify(result)) {
    if (!opts.keepOnEmpty) removeFromIndex(asset.id);
    return { fileId: asset.id, status: 'empty', indexed: 0, embedded: 0, reusedFromCache: 0, ingestMode: result.mode, embedMode: 'n/a', representations: [], chunkIds: [], mirrored: null };
  }

  // Flatten chunks across representations, tagging each with its representation type.
  const flat: { chunk: Chunk; repType: string }[] = [];
  for (const rep of result.representations) for (const chunk of rep.chunks) flat.push({ chunk, repType: rep.type });
  if (flat.length === 0) {
    if (!opts.keepOnEmpty) removeFromIndex(asset.id);
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
    // REQUIRE-LIVE, second half: a hash vector has no semantic relationship to anything, so
    // writing one over a real one is strictly worse than leaving the row alone. Refuse BEFORE
    // `indexFile` and `bulkIndex` — the whole point of the check being here and not in the caller.
    if (opts.requireLive && embedded.mode !== 'live') {
      refuseOfflineMock(
        `Cannot re-index “${asset.name}”: the embeddings gateway answered with a stand-in ` +
          `(${embedded.mode}) rather than real vectors, so hash vectors would have replaced the ` +
          'file’s embeddings. Nothing was written, removed or pruned.',
      );
    }
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
