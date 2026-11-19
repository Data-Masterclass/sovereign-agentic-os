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
  assertReindexAdmin,
  batchSize,
  buildReindexPlan,
  finishJob,
  jobFor,
  jobRemaining,
  recordUnit,
  startOrResume,
  REINDEX_UNIT_CAP,
  type EngineProbe,
  type IndexSnapshot,
  type ReindexFilter,
  type ReindexJob,
  type ReindexPlan,
  type ReindexPrincipal,
  type ReindexService,
  type ReindexUnit,
  type StoredUnit,
} from '@core/kernel/reindex';
import { indexAsset, type IndexReport } from '@tabs/files/lib/index-pipeline';
import { pruneChunksExcept } from '@tabs/files/lib/index-store';
import { actingCaller, type EmbedCaller } from '@tabs/files/lib/embed';
import { bodyForIndex, ensureHydrated, listAllForIndex } from '@tabs/files/lib/store';
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

export type UnitOutcome = { outcome: 'replaced' | 'failed' | 'skipped'; reason?: string };

export type FilesReindexDeps = {
  probeEngines: () => Promise<EngineProbe[]>;
  readSnapshot: () => Promise<IndexSnapshot>;
  storedUnits: () => StoredUnit[] | Promise<StoredUnit[]>;
  reindexUnit: (unitId: string, by: string) => Promise<UnitOutcome>;
};

type OsReply = { status: number; body: Record<string, unknown> } | null;

async function osJson(path: string, init?: RequestInit, ms = 6000): Promise<OsReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    return { status: res.status, body };
  } catch {
    return null; // transport failure or timeout — NOT the same fact as "the index is empty"
  } finally {
    clearTimeout(timer);
  }
}

async function probe(name: string, url: string): Promise<EngineProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    return { name, url, ready: res.ok, detail: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { name, url, ready: false, detail: (e as Error).message || 'no response' };
  } finally {
    clearTimeout(timer);
  }
}

/** Docling parses the documents; the gateway embeds the chunks. A run needs BOTH. */
export async function probeFilesEngines(): Promise<EngineProbe[]> {
  return Promise.all([
    probe('Docling (document parser)', `${config.doclingUrl}/health`),
    probe('embeddings gateway (LiteLLM)', `${config.litellmUrl}/health/liveliness`),
  ]);
}

function countOf(reply: OsReply): number {
  const n = reply?.body?.count;
  return typeof n === 'number' ? n : 0;
}

function bucketsOf(reply: OsReply): { key: string; doc_count: number }[] {
  const aggs = (reply?.body?.aggregations ?? {}) as Record<string, { buckets?: unknown }>;
  const raw = aggs.units?.buckets;
  return Array.isArray(raw) ? (raw as { key: string; doc_count: number }[]) : [];
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
 * Pull the knn field's dimension out of a `_mapping` body, whatever the index is called (the
 * reply is keyed by the concrete index name, which an alias makes unpredictable).
 */
export function mappingDimension(body: Record<string, unknown>, field: string): number | null {
  for (const entry of Object.values(body)) {
    const props = (entry as { mappings?: { properties?: Record<string, { dimension?: unknown }> } })?.mappings?.properties;
    const dim = props?.[field]?.dimension;
    if (typeof dim === 'number') return dim;
  }
  return null;
}

/** Every stored file the index is SUPPOSED to hold rows for. `stored-only` files are held, never indexed. */
async function storedFileUnits(): Promise<StoredUnit[]> {
  await ensureHydrated();
  return listAllForIndex()
    .filter(({ asset }) => asset.indexing.mode !== 'stored-only')
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
};

export const LIVE_UNIT_DEPS: UnitDeps = {
  body: bodyForIndex,
  // THE SAME call an upload makes, plus the two re-index opts. See the module header.
  index: (asset, text, caller) =>
    indexAsset(asset, text, { live: true, reembed: true, awaitMirror: true, requireLive: true, keepOnEmpty: true, caller }),
  prune: pruneChunksExcept,
};

/**
 * Re-index ONE file through the live path. Every "failure" return below leaves the file's existing
 * rows exactly where they were: the prune is the last statement, and it is only reached when the
 * parse, the embedding and the mirror all confirmed.
 */
export async function reindexOneFile(unitId: string, by: string, deps: UnitDeps = LIVE_UNIT_DEPS): Promise<UnitOutcome> {
  const body = deps.body(unitId);
  if (!body) return { outcome: 'skipped', reason: 'the file is no longer stored' };
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
//  plan · run
// ---------------------------------------------------------------------------

export async function planReindex(
  principal: ReindexPrincipal,
  opts: { filter: ReindexFilter; deps?: FilesReindexDeps },
): Promise<ReindexPlan> {
  assertReindexAdmin(principal);
  const deps = opts.deps ?? LIVE_DEPS;
  // A plan WRITES NOTHING and is readable during the very outage that caused the damage, which is
  // when an operator most wants to know how bad it is. The engines are probed so the panel can
  // disable Run with a reason — not so the plan can refuse.
  const [engines, snapshot, stored] = await Promise.all([
    deps.probeEngines(),
    deps.readSnapshot(),
    deps.storedUnits(),
  ]);
  return buildReindexPlan({
    target: TARGET,
    filter: opts.filter,
    engines,
    snapshot,
    stored,
    configuredDim: config.filesEmbedDim,
  });
}

/** The work list a resume needs: the ORIGINAL unit order, not whatever a later plan computed. */
const WORK_KEY = Symbol.for('soa.reindex.files.work');
function workList(): Map<string, ReindexUnit[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, ReindexUnit[]> | undefined>;
  if (!g[WORK_KEY]) g[WORK_KEY] = new Map();
  return g[WORK_KEY]!;
}

/** One batch at a time per target, so two concurrent callers cannot process the same units. */
const BUSY_KEY = Symbol.for('soa.reindex.files.busy');
function busy(set?: boolean): boolean {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (set !== undefined) g[BUSY_KEY] = set;
  return Boolean(g[BUSY_KEY]);
}

export async function runReindex(
  principal: ReindexPrincipal,
  plan: ReindexPlan | null,
  opts: { batch?: number; onProgress?: (job: ReindexJob) => void | Promise<void>; deps?: FilesReindexDeps } = {},
): Promise<{ started: boolean; job: ReindexJob; reason?: string }> {
  assertReindexAdmin(principal);
  const deps = opts.deps ?? LIVE_DEPS;

  // REFUSE BEFORE READING ANYTHING. The probe is the first statement that can fail, so a refusal
  // provably touches no row — which is the one promise this tool cannot afford to break.
  const engines = await deps.probeEngines();
  const down = engines.find((e) => !e.ready);
  if (down) {
    refuseOfflineMock(
      `Cannot re-index the Files corpus: ${down.name} is unreachable at ${down.url}` +
        `${down.detail ? ` (${down.detail})` : ''}. Re-parsing without the parser, or re-embedding ` +
        'without the gateway, would write exactly the stand-ins this re-index exists to remove, so ' +
        'nothing was read, replaced or deleted.',
    );
  }

  const existing = jobFor(TARGET);
  if (existing?.status === 'running' && busy()) {
    return { started: false, job: existing, reason: 'already-running' };
  }

  // RESUME (`plan === null`): no re-plan, no second index read — the running job's own work list
  // and cursor are the facts (review M4). Nothing to resume is a stated conflict, not a silent
  // no-op, because the caller believed there was a job.
  if (!plan) {
    if (!existing || existing.status !== 'running') {
      const err = new Error(
        `There is no running ${TARGET} re-index to continue. Run a plan first, then start one.`,
      ) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
  }

  const claim = plan
    ? startOrResume(TARGET, { filter: plan.filter, by: principal.id, total: plan.units.length })
    : { started: false, job: existing! };
  const job = claim.job;
  if (claim.started && plan) workList().set(job.id, plan.units);

  // A resume uses the list the job was CREATED with. If that list is GONE — the process was
  // replaced between batches — the cursor would index into a different list, so the units it
  // points past would silently never be re-indexed while the job reported progress. That is a
  // false claim about the corpus, so the job FAILS here instead (review low 4). A fresh
  // plan + run then redoes the work honestly; the re-index is idempotent, so that costs only time.
  const work = workList().get(job.id);
  if (!work) {
    const dead = finishJob(
      TARGET,
      'failed',
      'The work list for this job was lost (the process was replaced between batches), so its ' +
        'cursor no longer points into a known list. Nothing was indexed against it. Run Plan ' +
        'again and start a fresh re-index — re-indexing is idempotent.',
    );
    return { started: false, job: dead ?? job, reason: 'work-list-lost' };
  }

  busy(true);
  try {
    const slice = work.slice(job.cursor, job.cursor + batchSize(opts.batch));
    for (const unit of slice) {
      // An ABANDON landing mid-batch stops the batch at the next unit boundary: `recordUnit`
      // already no-ops on a job that is not running, and continuing to call the engines for a job
      // nobody is waiting for would spend budget on an answer no one reads.
      if (jobFor(TARGET)?.status !== 'running') break;
      let out: UnitOutcome;
      try {
        out = await deps.reindexUnit(unit.id, principal.id);
      } catch (e) {
        // An engine that went away mid-run, or a gateway rejection. The cursor stays where the
        // work stopped, so the next call resumes; the typed error reaches the caller unchanged.
        finishJob(TARGET, 'failed', (e as Error).message);
        workList().delete(job.id);
        throw e;
      }
      recordUnit(
        TARGET,
        out.outcome,
        out.outcome === 'replaced' ? undefined : { unit: unit.label, reason: out.reason ?? 'no reason given' },
      );
      const progressed = jobFor(TARGET);
      // AWAITED: a progress callback may itself be async (a UI flush, a re-entrant status read),
      // and a fire-and-forget call here would let the batch finish before the callback ran.
      if (progressed && opts.onProgress) await opts.onProgress(progressed);
    }
    const after = jobFor(TARGET)!;
    if (after.status === 'running' && jobRemaining(after) === 0) {
      finishJob(TARGET, 'done');
      workList().delete(job.id);
    }
    return { started: claim.started, job: jobFor(TARGET)!, reason: claim.started ? undefined : 'resumed' };
  } finally {
    busy(false);
  }
}

/**
 * ABANDON the target's running job (review H3). The only way out of a job whose process died
 * between batches: `busy` is process state, so without this the target stays wedged — the panel
 * would show a running job forever and every Continue would answer `already-running`.
 *
 * It marks the job FAILED and says who abandoned it rather than deleting it, because "somebody
 * gave up on this at 40/900" is a fact an operator needs afterwards. Nothing in the index is
 * touched or rolled back: the units already replaced are correctly replaced, and a later run
 * redoes the rest from a fresh plan.
 */
export async function abandonReindex(
  principal: ReindexPrincipal,
): Promise<{ abandoned: boolean; job: ReindexJob | null; reason?: string }> {
  assertReindexAdmin(principal);
  const job = jobFor(TARGET);
  if (!job || job.status !== 'running') {
    busy(false); // a stale flag with no running job is exactly what this door exists to clear
    return { abandoned: false, job, reason: 'nothing-running' };
  }
  const failed = finishJob(TARGET, 'failed', `Abandoned by ${principal.id} at ${job.cursor}/${job.total}. ` +
    'The units already replaced are replaced; the rest were not touched. Plan again to redo them.');
  workList().delete(job.id);
  busy(false);
  return { abandoned: true, job: failed ?? job };
}

/** Is a batch executing right now? Exposed so the panel can tell "running" from "busy" (H2). */
export function inFlight(): boolean {
  return busy();
}

/** Test hook — the work list and the busy flag are process state, like the index itself. */
export function __resetFilesReindex(): void {
  workList().clear();
  busy(false);
}

/** The injectable live defaults, exported so a door can reuse them and a test can assert them. */
export const filesReindexService: ReindexService = { planReindex, runReindex, abandonReindex, inFlight };
