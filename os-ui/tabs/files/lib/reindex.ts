/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Files corpus re-index — plan what is suspect, then re-parse and re-embed it
 * USER STORY: As a platform admin I want to pay down the index debt the offline-mock outage left
 *             — invented document text and hash vectors — by re-running the REAL Docling parse
 *             and the REAL embeddings gateway over the rows that need it, and I want the tool to
 *             refuse rather than quietly re-poison the index when those services are down.
 * ARCHITECTURE:
 *   - TAB-OWNED. The contract (shapes, the one-job-per-target table, the pure plan assembly) is
 *     `@core/kernel/reindex`; everything corpus-specific — the `files` index field names, the
 *     Docling probe, what a unit of work IS — is here, because the kernel may not know its tabs
 *     and the Knowledge corpus answers every one of those questions differently.
 *   - THE SAME LIVE PATH AS AN UPLOAD, deliberately. A unit is re-indexed by `indexAsset(asset,
 *     text, { live: true, reembed: true, awaitMirror: true })` — the very function the upload
 *     route calls, with the live Docling adapter and the live gateway embedder. Two opts matter:
 *     `reembed` empties the content-hash vector cache (the cached vector may be the very hash
 *     vector this tool exists to replace), and `awaitMirror` waits for the OpenSearch write so
 *     the stale-row prune can only happen after the new rows are really there.
 *   - IT REFUSES, IT NEVER FALLS BACK. The engines are probed BEFORE anything is read or
 *     written; unreachable ⇒ `refuseOfflineMock(...)`, the house-typed ENGINE_UNAVAILABLE (503)
 *     that `core/mcp/server.ts` maps for an agent and the route maps for a browser. And because a
 *     laptop MAY fabricate (`OS_OFFLINE_MOCK=allow`), a parser or gateway that falls over MID-RUN
 *     is refused too — by `indexAsset`'s own `requireLive`, which raises BEFORE the in-process
 *     write and before `bulkIndex` (review M1; the first version read the mode off the report,
 *     which is one statement after the rows were already overwritten). The service re-reads the
 *     report's `ingestMode`/`embedMode` as a second line, so a future caller that forgets
 *     `requireLive` still cannot prune around a stand-in.
 *   - NEVER DELETES A ROW IT COULD NOT REPLACE. Add, then prune: `bulkIndex` overwrites by chunk
 *     id, and `pruneChunksExcept(fileId, report.chunkIds)` runs only after the mirror confirmed.
 *   - HONEST ABOUT ITS OWN BLIND SPOT. `marked` can only find rows that still carry evidence; the
 *     plan carries {@link UNMARKED_CAVEAT} for the rows that do not. See
 *     `docs/superpowers/plans/2026-11-19-reindex-files-knowledge.md` §1.1.
 *   - Dependency-injected at ONE seam ({@link FilesReindexDeps}) so the classification and the
 *     run loop are unit-testable without a cluster — the pattern `index-pipeline.ts` already uses
 *     for its adapter and embedder. The DEFAULTS are the live path, and a source tripwire in the
 *     test asserts they really are.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { refuseOfflineMock } from '@core/kernel/offline-mock';
import {
  REINDEX_UNIT_CAP,
  type EngineProbe,
  type IndexSnapshot,
  type ReindexService,
  type StoredUnit,
} from '@core/kernel/reindex';
import {
  bucketsOf,
  countOf,
  createReindexRunner,
  mappingDimension,
  osJson,
  probeEngine as probe,
  type ReindexRunnerDeps,
  type UnitOutcome,
} from '@core/kernel/reindex-runner';
import { indexAsset, type IndexReport } from '@tabs/files/lib/index-pipeline';
import { pruneChunksExcept } from '@tabs/files/lib/index-store';
import { actingCaller, type EmbedCaller } from '@tabs/files/lib/embed';
import { bodyForIndex, ensureHydrated, extractionSubject, listAllForIndex } from '@tabs/files/lib/store';
import { extractFileText, type ExtractResult } from '@tabs/files/lib/extract';
import { LIVE_EXTRACT_DEPS } from '@tabs/files/lib/pipeline-server';
import type { FileAsset } from '@tabs/files/lib/asset-schema';

const TARGET = 'files' as const;

// ---------------------------------------------------------------------------
//  The queries. Exported because what we can and cannot detect IS the design.
// ---------------------------------------------------------------------------

/**
 * The strings a pre-guard stand-in would have been labelled with, in the fields that could
 * plausibly carry such a label.
 *
 * Read this together with the plan's §1.1: the `files` mapping
 * (`tabs/files/lib/index-store.ts` `filesIndexMapping`) never carried any of these fields, so on
 * this corpus the honest expected count is **0**. We query for them anyway rather than hard-code
 * a zero, for two reasons: a hand-written or future writer may stamp one (the `knowledge` index
 * really does persist a `source`), and a count the operator can see is worth more than a constant
 * they have to take on trust. A query against an unmapped field matches nothing and does not
 * error, which is what makes this safe.
 */
export const STANDIN_MARKERS = ['offline-hash', 'offline-mock', 'mock', 'demo-seed'] as const;
export const MARKER_FIELDS = ['source', 'embed_source', 'embedSource', 'mode', 'embed_mode', 'ingest_mode'] as const;

/** Rows whose own fields still admit they are a stand-in. */
export function markedQuery(): Record<string, unknown> {
  const should: Record<string, unknown>[] = [];
  for (const field of MARKER_FIELDS) {
    for (const marker of STANDIN_MARKERS) {
      // `match_phrase` so a multi-token marker must appear adjacently (an analysed `text` field),
      // `term` on the `.keyword` subfield for the exact-value case. One of the two always applies.
      should.push({ match_phrase: { [field]: marker } });
      should.push({ term: { [`${field}.keyword`]: marker } });
    }
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/** Rows with no vector at all. An empty array counts as absent in OpenSearch, so this covers both. */
export function missingVectorQuery(field = 'vector'): Record<string, unknown> {
  return { bool: { must_not: [{ exists: { field } }] } };
}

// ---------------------------------------------------------------------------
//  The live seam
// ---------------------------------------------------------------------------

export type { UnitOutcome };
/** Re-exported: the files test (and any caller) reads it from here. */
export { mappingDimension };

export type FilesReindexDeps = ReindexRunnerDeps;

/** Docling parses the documents; the gateway embeds the chunks. A run needs BOTH. */
export async function probeFilesEngines(): Promise<EngineProbe[]> {
  return Promise.all([
    probe('Docling (document parser)', `${config.doclingUrl}/health`),
    probe('embeddings gateway (LiteLLM)', `${config.litellmUrl}/health/liveliness`),
  ]);
}

const unitAgg = { units: { terms: { field: 'file_id', size: REINDEX_UNIT_CAP } } };

/** Read the `files` index: totals, the mapping dimension, and which units carry which evidence. */
export async function readFilesSnapshot(): Promise<IndexSnapshot> {
  const idx = `/${config.filesIndex}`;
  const mapping = await osJson(`${idx}/_mapping`, { method: 'GET' });
  if (mapping === null) {
    // The index could not be reached at all. Report that, rather than an empty corpus.
    return {
      reachable: false, rowsTotal: 0, mappingDim: null, rowsMarked: 0, rowsMissingVector: 0,
      rowsByUnit: new Map(), unitsMarked: new Set(), unitsMissingVector: new Set(), looseDocs: [], truncated: false,
    };
  }
  if (mapping.status === 404) {
    // No index yet: nothing has ever been written, so there is nothing to re-index. Honest, and
    // distinct from "unreachable" — the plan will show zeros and a ready state.
    return {
      reachable: true, rowsTotal: 0, mappingDim: null, rowsMarked: 0, rowsMissingVector: 0,
      rowsByUnit: new Map(), unitsMarked: new Set(), unitsMissingVector: new Set(), looseDocs: [], truncated: false,
    };
  }
  const dim = mappingDimension(mapping.body, 'vector');

  const [all, marked, noVec, allUnits, markedUnits, noVecUnits] = await Promise.all([
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: { match_all: {} } }) }),
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: markedQuery() }) }),
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: missingVectorQuery() }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, aggs: unitAgg }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, query: markedQuery(), aggs: unitAgg }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, query: missingVectorQuery(), aggs: unitAgg }) }),
  ]);

  const rowsByUnit = new Map<string, number>();
  for (const b of bucketsOf(allUnits)) rowsByUnit.set(b.key, b.doc_count);
  return {
    reachable: true,
    rowsTotal: countOf(all),
    mappingDim: dim,
    rowsMarked: countOf(marked),
    rowsMissingVector: countOf(noVec),
    rowsByUnit,
    unitsMarked: new Set(bucketsOf(markedUnits).map((b) => b.key)),
    unitsMissingVector: new Set(bucketsOf(noVecUnits).map((b) => b.key)),
    looseDocs: [], // every files row carries a file_id; there is no loose row on this corpus
    truncated: bucketsOf(allUnits).length >= REINDEX_UNIT_CAP,
  };
}

/**
 * Every stored file the index is SUPPOSED to hold rows for.
 *
 * `stored-only` files are held, never indexed — with ONE exception (the PDF backfill,
 * 2026-11-19): a file that is stored-only only because no text could be read from it when it was
 * uploaded (`store.extractionEligibility` — never a `restricted` file, never an owner's opt-out).
 * Such a file has bytes in the object store and no row in the index, so the plan lists it as
 * `missing-representation` and the default `marked` filter picks it up; the run then reads its
 * text from the bytes before indexing it. See {@link reindexOneFile}.
 */
export async function storedFileUnits(): Promise<StoredUnit[]> {
  await ensureHydrated();
  return listAllForIndex()
    .filter(({ asset }) => asset.indexing.mode !== 'stored-only' || extractionSubject(asset.id)?.eligibility.eligible === true)
    .map(({ asset }) => ({ id: asset.id, label: asset.name }));
}

/**
 * The three primitives one unit of work needs. Injected so the ORDER (add, verify, only then
 * prune) is assertable without a cluster; the defaults are the live path.
 */
export type UnitDeps = {
  body: (id: string) => { asset: FileAsset; text: string } | null;
  index: (asset: FileAsset, text: string, caller: EmbedCaller | undefined) => Promise<IndexReport>;
  prune: (fileId: string, keepIds: string[]) => Promise<boolean>;
  /**
   * Read a text-less file's text from its stored bytes and store it on the record (Docling).
   * Returns `skipped` — without calling the parser — for a restricted / opted-out / non-document
   * file. Optional so a test of the add-then-prune order need not supply it.
   */
  extract?: (id: string) => Promise<ExtractResult>;
};

/** How long one re-index unit waits for a text extraction before moving on. */
export const BACKFILL_EXTRACT_WAIT_MS = 120_000;

export const LIVE_UNIT_DEPS: UnitDeps = {
  body: bodyForIndex,
  // THE SAME call an upload makes, plus the two re-index opts. See the module header.
  index: (asset, text, caller) =>
    indexAsset(asset, text, { live: true, reembed: true, awaitMirror: true, requireLive: true, keepOnEmpty: true, caller }),
  prune: pruneChunksExcept,
  // Extraction only STORES the text here; the strict `index` above (re-embed, awaited mirror,
  // require-live) is what indexes it, so the ordinary best-effort indexer is switched off.
  // Bounded per unit: a long scan must not hold a batch request open for the parser's whole
  // deadline. Past the wait the unit is reported failed-for-now while the extraction finishes in
  // the background and stores its text; the next plan lists the file again and indexes it.
  extract: (id) => extractFileText(id, { ...LIVE_EXTRACT_DEPS, index: async () => undefined }, { waitMs: BACKFILL_EXTRACT_WAIT_MS }),
};

/**
 * Re-index ONE file through the live path. Every "failure" return below leaves the file's existing
 * rows exactly where they were: the prune is the last statement, and it is only reached when the
 * parse, the embedding and the mirror all confirmed.
 */
export async function reindexOneFile(unitId: string, by: string, deps: UnitDeps = LIVE_UNIT_DEPS): Promise<UnitOutcome> {
  let body = deps.body(unitId);
  if (!body) return { outcome: 'skipped', reason: 'the file is no longer stored' };
  // THE BACKFILL. No text on record ⇒ ask for it to be read from the stored bytes first. The
  // extractor itself refuses (`skipped`, parser never called) for a restricted file, an owner's
  // opt-out and anything that is not a parseable document, so this cannot widen what is indexed.
  if (!body.text.trim() && deps.extract) {
    const ex = await deps.extract(unitId);
    if (ex.state === 'failed') {
      if (ex.code === 'parser-unreachable') {
        // The engine went away mid-run: stop the JOB (typed), exactly as a vanished parser
        // always has — do not walk the rest of the corpus marking every file failed.
        refuseOfflineMock(`Cannot re-index “${body.asset.name}”: ${ex.reason} Nothing was written, removed or pruned.`);
      }
      return { outcome: 'failed', reason: `no text could be extracted — ${ex.reason} The file stays stored-only.` };
    }
    if (ex.state === 'pending') {
      return { outcome: 'failed', reason: 'text extraction is still running for this file (a long document) — its text is stored when it finishes; plan and run the re-index again to index it' };
    }
    if (ex.state === 'extracted') body = deps.body(unitId) ?? body;
  }
  if (body.asset.indexing.mode === 'stored-only') {
    return { outcome: 'skipped', reason: 'stored-only: held by policy, never indexed' };
  }
  const report = await deps.index(body.asset, body.text, actingCaller(by, body.asset.domain));
  if (report.status !== 'searchable') {
    // `keepOnEmpty` is what makes this sentence true: without it the pipeline drops the file's
    // in-process rows on an empty parse (review M2).
    return { outcome: 'failed', reason: `the parse produced nothing indexable (${report.status}) — existing rows left in place` };
  }
  if (report.ingestMode !== 'live') {
    return { outcome: 'failed', reason: `the parser answered with a stand-in (ingest ${report.ingestMode}) — nothing was replaced or pruned` };
  }
  if (report.embedMode !== 'live') {
    return { outcome: 'failed', reason: `the embeddings gateway answered with a stand-in (embed ${report.embedMode}) — nothing was replaced or pruned` };
  }
  if (report.mirrored === false) {
    return { outcome: 'failed', reason: 'OpenSearch did not accept the rewrite — the existing rows were left untouched' };
  }
  await deps.prune(unitId, report.chunkIds);
  return { outcome: 'replaced' };
}

const LIVE_DEPS: FilesReindexDeps = {
  probeEngines: probeFilesEngines,
  readSnapshot: readFilesSnapshot,
  storedUnits: storedFileUnits,
  reindexUnit: (unitId, by) => reindexOneFile(unitId, by),
};

// ---------------------------------------------------------------------------
//  plan · run · abandon — the shared loop in `@core/kernel/reindex-runner`
// ---------------------------------------------------------------------------

const runner = createReindexRunner({
  target: TARGET,
  liveDeps: () => LIVE_DEPS,
  configuredDim: () => config.filesEmbedDim,
  refuse: (down) =>
    refuseOfflineMock(
      `Cannot re-index the Files corpus: ${down.name} is unreachable at ${down.url}` +
        `${down.detail ? ` (${down.detail})` : ''}. Re-parsing without the parser, or re-embedding ` +
        'without the gateway, would write exactly the stand-ins this re-index exists to remove, so ' +
        'nothing was read, replaced or deleted.',
    ),
});

export const { planReindex, runReindex, abandonReindex, inFlight } = runner;

/** Test hook — the work list and the busy flag are process state, like the index itself. */
export function __resetFilesReindex(): void {
  runner.reset();
}

/** The injectable live defaults, exported so a door can reuse them and a test can assert them. */
export const filesReindexService: ReindexService = runner.service;
