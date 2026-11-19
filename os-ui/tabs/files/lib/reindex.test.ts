/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Files re-index — what it finds, what it refuses, and what it never deletes
 * USER STORY: As a platform admin paying down the offline-mock index debt I need to know that a
 *             dry run tells me the truth about what is detectable, that a run with the parser or
 *             the gateway down touches NOTHING, and that a unit it could not re-parse keeps the
 *             rows it already had.
 * ARCHITECTURE:
 *   - Offline: the engine probe, the index read and the per-unit work are injected at the one
 *     seam the module exposes; `globalThis.fetch` is stubbed for the tests that exercise the real
 *     OpenSearch query wiring (the pattern the two embed tests use).
 *   - A source tripwire asserts the DEFAULT unit path really is `indexAsset(..., { live: true,
 *     reembed: true, awaitMirror: true })` — the same call an upload makes — because an injected
 *     test can prove the loop and not the wiring.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  abandonReindex,
  inFlight,
  MARKER_FIELDS,
  STANDIN_MARKERS,
  markedQuery,
  missingVectorQuery,
  mappingDimension,
  readFilesSnapshot,
  reindexOneFile,
  planReindex,
  runReindex,
  storedFileUnits,
  filesReindexService,
  __resetFilesReindex,
  type FilesReindexDeps,
  type UnitDeps,
} from '@tabs/files/lib/reindex';
import { __resetReindexJobs, jobFor, type EngineProbe, type IndexSnapshot } from '@core/kernel/reindex';
import { isOfflineMockRefused } from '@core/kernel/offline-mock';
import { emptyAsset, serializeAsset, type FileAsset } from '@tabs/files/lib/asset-schema';
import { createFile, bodyForIndex, getFile, setIndexingMode, __putRecordForTests, __resetStore } from '@tabs/files/lib/store';
import { getBlob, putBlob, __resetBlobs } from '@tabs/files/lib/object-store';
import { extractFileText, __resetExtractFlights } from '@tabs/files/lib/extract';
import type { DoclingOutcome } from '@tabs/files/lib/ingest/docling-client';
import { __resetIndex, indexSize } from '@tabs/files/lib/index-store';
import type { IndexReport } from '@tabs/files/lib/index-pipeline';

const ADMIN = { id: 'u_admin', domains: ['sales'], role: 'admin' as const };
const BUILDER = { id: 'u_b', domains: ['sales'], role: 'builder' as const };

const realFetch = globalThis.fetch;

beforeEach(() => {
  __resetReindexJobs();
  __resetFilesReindex();
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
//  What is detectable at all
// ---------------------------------------------------------------------------

test('FILES REINDEX: the marked query looks for every stand-in label in every field that could carry one', () => {
  const q = markedQuery() as { bool: { should: Record<string, Record<string, string>>[]; minimum_should_match: number } };
  assert.equal(q.bool.minimum_should_match, 1);
  assert.equal(q.bool.should.length, MARKER_FIELDS.length * STANDIN_MARKERS.length * 2, 'phrase + keyword per pair');
  const json = JSON.stringify(q);
  for (const marker of STANDIN_MARKERS) assert.ok(json.includes(marker), `${marker} is looked for`);
  for (const field of MARKER_FIELDS) assert.ok(json.includes(field), `${field} is looked in`);
});

test('FILES REINDEX: the missing-vector query is must_not exists — an empty array counts as absent', () => {
  assert.deepEqual(missingVectorQuery(), { bool: { must_not: [{ exists: { field: 'vector' } }] } });
});

test('FILES REINDEX: the mapping dimension is read whatever the concrete index is called', () => {
  const body = { 'files-000001': { mappings: { properties: { vector: { type: 'knn_vector', dimension: 1024 } } } } };
  assert.equal(mappingDimension(body, 'vector'), 1024);
  assert.equal(mappingDimension({ files: { mappings: { properties: {} } } }, 'vector'), null);
  assert.equal(mappingDimension({}, 'vector'), null, 'an unreadable mapping is null, never a guess');
});

// ---------------------------------------------------------------------------
//  Reading the index: fixtures WITH markers and WITHOUT
// ---------------------------------------------------------------------------

type Canned = { count?: number; buckets?: { key: string; doc_count: number }[] };

/** Route the snapshot's nine-ish calls by (path, body) so a fixture can differ per query. */
function stubIndex(fixture: {
  mappingStatus?: number;
  dim?: number | null;
  all?: Canned;
  marked?: Canned;
  noVector?: Canned;
  transportFails?: boolean;
}): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (fixture.transportFails) throw new Error('ECONNREFUSED');
    if (u.includes('/_mapping')) {
      const status = fixture.mappingStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const dim = fixture.dim === undefined ? 384 : fixture.dim;
      const props = dim === null ? {} : { vector: { type: 'knn_vector', dimension: dim } };
      return new Response(JSON.stringify({ files: { mappings: { properties: props } } }), { status: 200 });
    }
    const body = String(init?.body ?? '');
    const which = body.includes('must_not') ? 'noVector' : body.includes('match_phrase') ? 'marked' : 'all';
    const canned = (fixture[which as 'all' | 'marked' | 'noVector'] ?? {}) as Canned;
    if (u.includes('/_count')) return new Response(JSON.stringify({ count: canned.count ?? 0 }), { status: 200 });
    return new Response(
      JSON.stringify({ aggregations: { units: { buckets: canned.buckets ?? [] } } }),
      { status: 200 },
    );
  }) as typeof fetch;
}

test('FILES REINDEX: a snapshot over rows WITH markers reports them per row AND per unit', async () => {
  stubIndex({
    dim: 384,
    all: { count: 30, buckets: [{ key: 'f_a', doc_count: 10 }, { key: 'f_b', doc_count: 20 }] },
    marked: { count: 10, buckets: [{ key: 'f_a', doc_count: 10 }] },
    noVector: { count: 0, buckets: [] },
  });
  const snap = await readFilesSnapshot();
  assert.equal(snap.reachable, true);
  assert.equal(snap.rowsTotal, 30);
  assert.equal(snap.rowsMarked, 10);
  assert.equal(snap.mappingDim, 384);
  assert.deepEqual([...snap.unitsMarked], ['f_a']);
  assert.equal(snap.rowsByUnit.get('f_b'), 20);
  assert.deepEqual(snap.looseDocs, [], 'every files row carries a file_id');
});

test('FILES REINDEX: a snapshot over rows WITHOUT markers reports zero — honestly, not as absence', async () => {
  stubIndex({
    dim: 384,
    all: { count: 12, buckets: [{ key: 'f_a', doc_count: 12 }] },
    marked: { count: 0, buckets: [] },
    noVector: { count: 0, buckets: [] },
  });
  const snap = await readFilesSnapshot();
  assert.equal(snap.rowsMarked, 0);
  assert.equal(snap.unitsMarked.size, 0);
  assert.equal(snap.rowsTotal, 12, 'the rows are there; nothing admits to being a stand-in');
});

test('FILES REINDEX: an unreachable index is NOT an empty one', async () => {
  stubIndex({ transportFails: true });
  const snap = await readFilesSnapshot();
  assert.equal(snap.reachable, false);
  assert.equal(snap.rowsTotal, 0);
  assert.equal(snap.mappingDim, null);
});

test('FILES REINDEX: an index that does not exist yet is reachable and empty', async () => {
  stubIndex({ mappingStatus: 404 });
  const snap = await readFilesSnapshot();
  assert.equal(snap.reachable, true, 'nothing was ever written, so there is nothing to re-index');
  assert.equal(snap.rowsTotal, 0);
});

// ---------------------------------------------------------------------------
//  plan
// ---------------------------------------------------------------------------

const UP: EngineProbe[] = [
  { name: 'Docling (document parser)', url: 'http://docling:5001/health', ready: true, detail: null },
  { name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: true, detail: null },
];
const DOWN: EngineProbe[] = [
  UP[0],
  { name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: false, detail: 'HTTP 503' },
];

function snapshot(over: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return {
    reachable: true, rowsTotal: 0, mappingDim: 384, rowsMarked: 0, rowsMissingVector: 0,
    rowsByUnit: new Map(), unitsMarked: new Set(), unitsMissingVector: new Set(), looseDocs: [], truncated: false,
    ...over,
  };
}

function deps(over: Partial<FilesReindexDeps> = {}): FilesReindexDeps {
  return {
    probeEngines: async () => UP,
    readSnapshot: async () => snapshot(),
    storedUnits: () => [],
    reindexUnit: async () => ({ outcome: 'replaced' }),
    ...over,
  };
}

test('PLAN (files): counts per reason over a corpus with markers, a missing vector and a gap', async () => {
  const plan = await planReindex(ADMIN, {
    filter: 'marked',
    deps: deps({
      storedUnits: () => [
        { id: 'f_marked', label: 'invented.pdf' },
        { id: 'f_clean', label: 'real.pdf' },
        { id: 'f_novec', label: 'novector.pdf' },
        { id: 'f_gap', label: 'never-parsed.pdf' },
      ],
      readSnapshot: async () =>
        snapshot({
          rowsTotal: 24, rowsMarked: 4, rowsMissingVector: 2,
          rowsByUnit: new Map([['f_marked', 4], ['f_clean', 18], ['f_novec', 2]]),
          unitsMarked: new Set(['f_marked']),
          unitsMissingVector: new Set(['f_novec']),
        }),
    }),
  });
  assert.deepEqual(plan.counts, {
    marked: 4, 'missing-vector': 2, 'missing-representation': 1, 'dimension-mismatch': 0, all: 24,
  });
  assert.deepEqual(plan.units.map((u) => u.id).sort(), ['f_gap', 'f_marked', 'f_novec']);
  assert.equal(plan.ready, true);
  assert.equal(plan.target, 'files');
  assert.ok(plan.unmarkedCaveat.includes('‘marked’'), 'the caveat travels in the payload');
});

test('PLAN (files): the Run button is the plan — down engine, not ready, named reason', async () => {
  const plan = await planReindex(ADMIN, { filter: 'all', deps: deps({ probeEngines: async () => DOWN }) });
  assert.equal(plan.ready, false);
  assert.match(plan.blockedReason!, /embeddings gateway/);
  assert.match(plan.blockedReason!, /HTTP 503/);
});

test('PLAN (files): admin-only — a builder cannot even dry-run the corpus', async () => {
  await assert.rejects(
    () => planReindex(BUILDER, { filter: 'marked', deps: deps() }),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

// ---------------------------------------------------------------------------
//  run
// ---------------------------------------------------------------------------

const PLAN_OF = (ids: string[], filter: 'marked' | 'all' = 'marked') => ({
  target: 'files' as const,
  filter,
  counts: { marked: ids.length, 'missing-representation': 0, 'missing-vector': 0, 'dimension-mismatch': 0, all: ids.length },
  units: ids.map((id) => ({ id, label: `${id}.pdf`, reasons: ['marked' as const], rows: 1 })),
  rowsTotal: ids.length,
  mappingDim: 384,
  configuredDim: 384,
  engines: UP,
  ready: true,
  blockedReason: null,
  unmarkedCaveat: 'caveat',
  truncated: false,
});

test('RUN (files): the gateway is down ⇒ ENGINE_UNAVAILABLE, and NO row is touched', async () => {
  const touched: string[] = [];
  await assert.rejects(
    () =>
      runReindex(ADMIN, PLAN_OF(['f_1', 'f_2']), {
        deps: deps({
          probeEngines: async () => DOWN,
          reindexUnit: async (id) => {
            touched.push(id);
            return { outcome: 'replaced' };
          },
        }),
      }),
    (e: unknown) => {
      assert.ok(isOfflineMockRefused(e), 'the house-typed refusal, so both doors map it');
      assert.equal((e as { status?: number }).status, 503);
      assert.match((e as Error).message, /nothing was read, replaced or deleted/);
      return true;
    },
  );
  assert.deepEqual(touched, [], 'the probe runs before anything is read');
  assert.equal(jobFor('files'), null, 'and no job was even claimed');
});

test('RUN (files): replaces the units in the plan and leaves everything else alone', async () => {
  const seen: string[] = [];
  const res = await runReindex(ADMIN, PLAN_OF(['f_marked_1', 'f_marked_2']), {
    deps: deps({
      reindexUnit: async (id) => {
        seen.push(id);
        return { outcome: 'replaced' };
      },
    }),
  });
  assert.deepEqual(seen, ['f_marked_1', 'f_marked_2'], 'only the planned units — a clean file is never re-parsed');
  assert.equal(res.started, true);
  assert.equal(res.job.status, 'done');
  assert.equal(res.job.replaced, 2);
  assert.equal(res.job.failed, 0);
});

test('RUN (files): a unit that could not be replaced is a failure WITH its reason, and the run goes on', async () => {
  const res = await runReindex(ADMIN, PLAN_OF(['f_ok', 'f_bad']), {
    deps: deps({
      reindexUnit: async (id) =>
        id === 'f_bad'
          ? { outcome: 'failed', reason: 'the parser answered with a stand-in (ingest mock) — nothing was replaced or pruned' }
          : { outcome: 'replaced' },
    }),
  });
  assert.equal(res.job.status, 'done');
  assert.equal(res.job.replaced, 1);
  assert.equal(res.job.failed, 1);
  assert.equal(res.job.failures.length, 1);
  assert.match(res.job.failures[0].reason, /nothing was replaced or pruned/);
});

test('RUN (files): bounded per call and RESUMABLE — an interrupted batch costs only that batch', async () => {
  const seen: string[] = [];
  const d = deps({
    reindexUnit: async (id) => {
      seen.push(id);
      return { outcome: 'replaced' };
    },
  });
  const plan = PLAN_OF(['a', 'b', 'c', 'd', 'e']);
  const first = await runReindex(ADMIN, plan, { batch: 2, deps: d });
  assert.equal(first.job.status, 'running');
  assert.equal(first.job.cursor, 2);
  assert.deepEqual(seen, ['a', 'b']);

  const second = await runReindex(ADMIN, plan, { batch: 2, deps: d });
  assert.equal(second.started, false, 'the same job, resumed — never a twin');
  assert.equal(second.reason, 'resumed');
  assert.equal(second.job.id, first.job.id);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'], 'it picked up at the cursor, not at the start');

  const third = await runReindex(ADMIN, plan, { batch: 2, deps: d });
  assert.equal(third.job.status, 'done');
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e'], 'every unit exactly once across the three calls');
});

test('RUN (files): a resume uses the job’s ORIGINAL work list, not a later plan’s', async () => {
  const seen: string[] = [];
  const d = deps({
    reindexUnit: async (id) => {
      seen.push(id);
      return { outcome: 'replaced' };
    },
  });
  await runReindex(ADMIN, PLAN_OF(['a', 'b', 'c']), { batch: 1, deps: d });
  // A second plan, computed later, lists different units — the running job's list must win.
  await runReindex(ADMIN, PLAN_OF(['x', 'y', 'z']), { batch: 1, deps: d });
  assert.deepEqual(seen, ['a', 'b'], 'the work in flight is the fact');
});

test('RUN (files): a concurrent caller reports status rather than starting twice', async () => {
  let concurrent: { started: boolean; reason?: string; job: { cursor: number } } | null = null;
  const d = deps({ reindexUnit: async () => ({ outcome: 'replaced' }) });
  await runReindex(ADMIN, PLAN_OF(['a', 'b']), {
    batch: 1,
    deps: d,
    // Re-entrant, and AWAITED by the run loop — exactly what two admins pressing Run at the same
    // moment look like, with the second arriving while the first batch is still in flight.
    onProgress: async () => {
      if (!concurrent) concurrent = await runReindex(ADMIN, PLAN_OF(['a', 'b']), { batch: 1, deps: d });
    },
  });
  assert.ok(concurrent, 'the second call returned');
  assert.equal(concurrent!.started, false);
  assert.equal(concurrent!.reason, 'already-running');
  assert.equal(concurrent!.job.cursor, 1, 'it reported the real progress of the run in flight');
});

test('RUN (files): an engine that dies MID-run fails the job, keeps the cursor and rethrows', async () => {
  const plan = PLAN_OF(['a', 'b', 'c']);
  await assert.rejects(
    () =>
      runReindex(ADMIN, plan, {
        deps: deps({
          reindexUnit: async (id) => {
            if (id === 'b') throw Object.assign(new Error('gateway went away'), { status: 503, code: 'ENGINE_UNAVAILABLE' });
            return { outcome: 'replaced' };
          },
        }),
      }),
    /gateway went away/,
  );
  const job = jobFor('files')!;
  assert.equal(job.status, 'failed');
  assert.equal(job.cursor, 1, 'one unit done; the rest is still to do');
  assert.match(job.error!, /gateway went away/);
});

test('RUN (files): idempotent — running the same plan again replaces the same units again', async () => {
  const runs: string[][] = [];
  const d = deps({
    reindexUnit: async (id) => {
      runs[runs.length - 1].push(id);
      return { outcome: 'replaced' };
    },
  });
  runs.push([]);
  await runReindex(ADMIN, PLAN_OF(['a', 'b']), { deps: d });
  runs.push([]);
  const again = await runReindex(ADMIN, PLAN_OF(['a', 'b']), { deps: d });
  assert.deepEqual(runs[0], runs[1], 'the same work, the same result');
  assert.equal(again.started, true, 'the finished job freed the slot');
  assert.equal(again.job.replaced, 2);
});

test('RUN (files): admin-only', async () => {
  await assert.rejects(
    () => runReindex(BUILDER, PLAN_OF(['a']), { deps: deps() }),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

// ---------------------------------------------------------------------------
//  One unit: the order that makes "never delete what you could not replace" true
// ---------------------------------------------------------------------------

function asset(over: Partial<FileAsset> = {}): FileAsset {
  return { ...emptyAsset({ id: 'f_1', name: 'contract.pdf', owner: 'amir', domain: 'sales' }), ...over };
}

function report(over: Partial<IndexReport> = {}): IndexReport {
  return {
    fileId: 'f_1', status: 'searchable', indexed: 3, embedded: 3, reusedFromCache: 0,
    ingestMode: 'live', embedMode: 'live', representations: ['text'],
    chunkIds: ['f_1#0', 'f_1#1', 'f_1#2'], mirrored: true,
    ...over,
  };
}

function unitDeps(over: Partial<UnitDeps> = {}, pruned: string[][] = []): UnitDeps {
  return {
    body: () => ({ asset: asset(), text: 'the real contract text' }),
    index: async () => report(),
    prune: async (fileId, keep) => {
      pruned.push([fileId, ...keep]);
      return true;
    },
    ...over,
  };
}

test('UNIT (files): a live parse + live embedding + a confirmed mirror ⇒ replaced, then pruned', async () => {
  const pruned: string[][] = [];
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({}, pruned));
  assert.deepEqual(out, { outcome: 'replaced' });
  assert.deepEqual(pruned, [['f_1', 'f_1#0', 'f_1#1', 'f_1#2']], 'the prune keeps exactly what was just written');
});

test('UNIT (files): a parse that came back as a STAND-IN fails, and prunes nothing', async () => {
  const pruned: string[][] = [];
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({ index: async () => report({ ingestMode: 'mock' }) }, pruned));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /stand-in \(ingest mock\)/);
  assert.deepEqual(pruned, [], 'the old rows stay — a stand-in must never replace them');
});

test('UNIT (files): an embedding that came back as a STAND-IN fails, and prunes nothing', async () => {
  const pruned: string[][] = [];
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({ index: async () => report({ embedMode: 'mock' }) }, pruned));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /stand-in \(embed mock\)/);
  assert.deepEqual(pruned, []);
});

test('UNIT (files): a mirror that did not accept the rewrite fails, and prunes nothing', async () => {
  const pruned: string[][] = [];
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({ index: async () => report({ mirrored: false }) }, pruned));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /left untouched/);
  assert.deepEqual(pruned, [], 'nothing was deleted, because nothing was replaced');
});

test('UNIT (files): a parse that produced nothing indexable fails rather than emptying the file', async () => {
  const pruned: string[][] = [];
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({ index: async () => report({ status: 'empty', chunkIds: [] }) }, pruned));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /existing rows left in place/);
  assert.deepEqual(pruned, []);
});

test('UNIT (files): a file that is gone, or held stored-only, is SKIPPED — not a failure', async () => {
  const gone = await reindexOneFile('f_x', 'u_admin', unitDeps({ body: () => null }));
  assert.equal(gone.outcome, 'skipped');
  assert.match(gone.reason!, /no longer stored/);

  const held = asset();
  held.indexing.mode = 'stored-only';
  const out = await reindexOneFile('f_1', 'u_admin', unitDeps({ body: () => ({ asset: held, text: 'x' }) }));
  assert.equal(out.outcome, 'skipped');
  assert.match(out.reason!, /stored-only/);
});

// ---------------------------------------------------------------------------
//  The wiring an injected test cannot prove
// ---------------------------------------------------------------------------

const SRC = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'reindex.ts'), 'utf8');

test('TRIPWIRE (files): the default unit path is the SAME indexAsset call an upload makes, plus the two re-index opts', () => {
  assert.match(
    SRC,
    /indexAsset\(asset, text, \{ live: true, reembed: true, awaitMirror: true, requireLive: true, keepOnEmpty: true, caller \}\)/,
    'reembed empties the hash-vector cache; awaitMirror is what makes the prune safe; requireLive ' +
      'refuses a stand-in BEFORE the write; keepOnEmpty leaves existing rows alone',
  );
  assert.match(SRC, /prune: pruneChunksExcept/);
  assert.match(SRC, /probe\('Docling \(document parser\)'/);
});

test('TRIPWIRE (files): the service refuses, and can only ever refuse — it never consults the predicate', () => {
  assert.match(SRC, /refuseOfflineMock\(/, 'an unreachable engine is the house-typed refusal');
  assert.ok(!/offlineMockAllowed\(/.test(SRC), 'a re-index may never opt INTO fabrication');
});

test('FILES REINDEX: the exported service is the contract both doors use', () => {
  assert.equal(typeof filesReindexService.planReindex, 'function');
  assert.equal(typeof filesReindexService.runReindex, 'function');
});

// ---------------------------------------------------------------------------
//  H3 — abandoning a job, the only way out of one whose process was killed
// ---------------------------------------------------------------------------

test('H3 (files): abandon marks the running job failed, names who did it, and frees the target', async () => {
  const d = deps({ reindexUnit: async () => ({ outcome: 'replaced' }) });
  const started = await runReindex(ADMIN, PLAN_OF(['a', 'b', 'c']), { batch: 1, deps: d });
  assert.equal(started.job.status, 'running');

  const out = await abandonReindex(ADMIN);
  assert.equal(out.abandoned, true);
  assert.equal(out.job?.status, 'failed');
  assert.match(out.job!.error!, /Abandoned by u_admin at 1\/3/);
  assert.match(out.job!.error!, /already replaced are replaced/);
  assert.equal(inFlight(), false, 'the in-flight flag is cleared — that is the point of the door');

  // …and the target is genuinely free: a fresh plan starts a NEW job rather than reporting the old one.
  const again = await runReindex(ADMIN, PLAN_OF(['a']), { deps: d });
  assert.equal(again.started, true);
  assert.notEqual(again.job.id, started.job.id);
});

test('H3 (files): abandon with nothing running is honest, and still clears a stale flag', async () => {
  const out = await abandonReindex(ADMIN);
  assert.equal(out.abandoned, false);
  assert.equal(out.reason, 'nothing-running');
  assert.equal(out.job, null);
  assert.equal(inFlight(), false);
});

test('H3 (files): abandon is admin-only', async () => {
  await assert.rejects(() => abandonReindex(BUILDER), (e: Error & { status?: number }) => e.status === 403);
});

test('H3 (files): an abandon landing mid-batch stops the batch at the next unit', async () => {
  const seen: string[] = [];
  const d = deps({
    reindexUnit: async (id) => {
      seen.push(id);
      return { outcome: 'replaced' };
    },
  });
  await runReindex(ADMIN, PLAN_OF(['a', 'b', 'c', 'd']), {
    batch: 4,
    deps: d,
    onProgress: async () => {
      if (seen.length === 1) await abandonReindex(ADMIN);
    },
  });
  assert.deepEqual(seen, ['a'], 'the batch stopped instead of spending budget on an abandoned job');
  assert.equal(jobFor('files')?.status, 'failed');
});

// ---------------------------------------------------------------------------
//  M4 — a resume does not re-plan; low 4 — a lost work list fails the job
// ---------------------------------------------------------------------------

test('M4 (files): a resume (plan=null) continues the job WITHOUT re-planning', async () => {
  let plans = 0;
  const d = deps({
    readSnapshot: async () => {
      plans += 1;
      return snapshot();
    },
    reindexUnit: async () => ({ outcome: 'replaced' }),
  });
  const first = await runReindex(ADMIN, PLAN_OF(['a', 'b', 'c']), { batch: 1, deps: d });
  assert.equal(plans, 0, 'runReindex never plans — the caller hands it one');

  const resumed = await runReindex(ADMIN, null, { batch: 1, deps: d });
  assert.equal(resumed.started, false);
  assert.equal(resumed.reason, 'resumed');
  assert.equal(resumed.job.id, first.job.id);
  assert.equal(resumed.job.cursor, 2);
});

test('M4 (files): a resume with nothing running is a stated 409, not a silent no-op', async () => {
  await assert.rejects(
    () => runReindex(ADMIN, null, { deps: deps() }),
    (e: Error & { status?: number }) => e.status === 409 && /no running files re-index to continue/.test(e.message),
  );
});

test('LOW 4 (files): a job whose work list was lost FAILS rather than indexing a stale cursor', async () => {
  const d = deps({ reindexUnit: async () => ({ outcome: 'replaced' }) });
  const first = await runReindex(ADMIN, PLAN_OF(['a', 'b', 'c']), { batch: 1, deps: d });
  assert.equal(first.job.cursor, 1);

  __resetFilesReindex(); // what a process replacement looks like: the job survives, the list does not
  const out = await runReindex(ADMIN, PLAN_OF(['x', 'y', 'z']), { batch: 1, deps: d });
  assert.equal(out.reason, 'work-list-lost');
  assert.equal(out.job.status, 'failed');
  assert.match(out.job.error!, /Nothing was indexed against it/);
  assert.match(out.job.error!, /idempotent/);
});

// ---------------------------------------------------------------------------
//  M1 — the refusal happens BEFORE the write, through the real wiring
// ---------------------------------------------------------------------------

test('M1 (files): a stand-in embedding mid-run refuses BEFORE any OpenSearch write, through LIVE_UNIT_DEPS', async () => {
  __resetStore();
  __resetIndex();
  const asset = createFile({ id: 'amir', domains: ['sales'], role: 'admin' }, { name: 'contract.pdf', text: 'Auto renews after twelve months. Price capped at CPI.' });
  assert.equal(asset.indexing.mode, 'indexed');

  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    seen.push(`${(init?.method ?? 'GET').toUpperCase()} ${u}`);
    // Docling answers for real…
    if (u.includes('/convert')) {
      return new Response(JSON.stringify({ document: { texts: [{ text: 'Auto renews after twelve months.' }, { text: 'Price capped at CPI.' }] } }), { status: 200 });
    }
    // …and the embeddings gateway falls over MID-RUN, which is the whole scenario.
    if (u.includes('/v1/embeddings')) return new Response('upstream died', { status: 502 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    // The REAL unit path: no injected deps, so `indexAsset(..., {requireLive:true})` decides.
    () => reindexOneFile(asset.id, 'u_admin'),
    (e: unknown) => {
      assert.ok(isOfflineMockRefused(e), 'the typed refusal, raised inside the pipeline');
      assert.match((e as Error).message, /stand-in/);
      assert.match((e as Error).message, /Nothing was written, removed or pruned/);
      return true;
    },
  );

  const wrote = seen.filter((c) => /_bulk|_delete_by_query|_doc|_update/.test(c));
  assert.deepEqual(wrote, [], `no OpenSearch write may have happened, saw: ${wrote.join(', ')}`);
  assert.equal(indexSize(), 0, 'and the in-process index was not touched either');
});

test('M2 (files): an empty parse KEEPS the file’s existing rows (keepOnEmpty), as the reason claims', async () => {
  __resetStore();
  __resetIndex();
  const asset = createFile({ id: 'amir', domains: ['sales'], role: 'admin' }, { name: 'doc.pdf', text: 'real text that was indexed before' });

  // Seed the index the way a healthy earlier run would have.
  const { indexAsset } = await import('@tabs/files/lib/index-pipeline');
  const seed = await indexAsset(asset, 'real text that was indexed before', {
    adapter: (await import('@tabs/files/lib/ingest/mocks')).mockAdapterFor('doc'),
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0, 0]), model: 'm', dim: 3, mode: 'live' as const }),
  });
  assert.equal(seed.status, 'searchable');
  const before = indexSize();
  assert.ok(before > 0);

  // Now a re-index whose parse yields nothing: the rows must survive.
  const empty = await indexAsset(asset, '', {
    adapter: { name: 'x', kinds: ['doc'], apply: async () => ({ adapter: 'x', mode: 'live' as const, representations: [] }), verify: () => false },
    embed: async () => ({ vectors: [], model: 'm', dim: 3, mode: 'live' as const }),
    keepOnEmpty: true,
  });
  assert.equal(empty.status, 'empty');
  assert.equal(indexSize(), before, 'keepOnEmpty: "existing rows left in place" is now true');

  // Without the opt, the old behaviour (drop them) is unchanged for every other caller.
  await indexAsset(asset, '', {
    adapter: { name: 'x', kinds: ['doc'], apply: async () => ({ adapter: 'x', mode: 'live' as const, representations: [] }), verify: () => false },
    embed: async () => ({ vectors: [], model: 'm', dim: 3, mode: 'live' as const }),
  });
  assert.equal(indexSize(), 0, 'an ordinary empty re-parse still clears the file');
});

test('TRIPWIRE (files): the live unit path demands live AND keeps rows on an empty parse', () => {
  assert.match(SRC, /requireLive: true, keepOnEmpty: true/, 'both review fixes are bound in the default deps');
});

test('M (re-review): a unit still mid-await when the job is abandoned cannot advance the NEXT job', async () => {
  // THE RACE, end to end. `abandonReindex` clears the in-flight flag so the target can be re-run,
  // but it cannot un-await a unit that is already inside the parser or the gateway. A new job then
  // claims the slot, and the stale unit resolves afterwards. Target-keyed, its progress report
  // landed on the NEW job — which could reach `done` with units nobody re-indexed.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const slow = deps({
    reindexUnit: async () => {
      calls += 1;
      if (calls === 1) await gate; // unit 'a' is inside the engine and stays there
      return { outcome: 'replaced' };
    },
  });

  const stale = runReindex(ADMIN, PLAN_OF(['a', 'b', 'c']), { batch: 3, deps: slow });
  await new Promise((r) => setImmediate(r)); // let the loop reach the await
  const abandoned = await abandonReindex(ADMIN);
  assert.equal(abandoned.abandoned, true);

  // A NEW job, one unit of two, so it is still `running` when the stale unit resolves — the
  // window in which the bug could be observed at all.
  const fresh = await runReindex(ADMIN, PLAN_OF(['x', 'y']), {
    batch: 1,
    deps: deps({ reindexUnit: async () => ({ outcome: 'replaced' }) }),
  });
  assert.equal(fresh.started, true);
  assert.equal(fresh.job.cursor, 1);

  release();
  await stale; // the abandoned loop finishes its in-flight unit and unwinds

  const now = jobFor('files')!;
  assert.equal(now.id, fresh.job.id, 'the slot still belongs to the new job');
  assert.equal(now.cursor, 1, 'the stale unit did NOT advance it');
  assert.equal(now.replaced, 1, 'and was not counted as its work');
  assert.equal(now.status, 'running', 'so it cannot report done with a unit never processed');
  assert.equal(calls, 1, 'and the abandoned loop stopped instead of working through its batch');
});

// ---------------------------------------------------------------------------
//  THE PDF BACKFILL (2026-11-19): a file that is stored-only only because no text could be read
//  at upload is planned and recovered; a file that is stored-only by POLICY or CHOICE is not.
// ---------------------------------------------------------------------------

const OWNER = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const BACKFILL_BYTES = Buffer.from('%PDF-1.4 original');
const BACKFILL_TEXT = 'Invoice INV-7. Total due: 99 EUR.';

/** A record exactly as the pre-fix upload wrote it: stored-only, no reason, empty text, bytes stored. */
async function legacyPdf(id: string, name: string, over: { sensitivity?: 'restricted' } = {}): Promise<void> {
  const a = emptyAsset({ id, name, owner: 'amir', domain: 'sales', sensitivity: over.sensitivity });
  a.deepLink = `s3://files/amir/${name}`;
  a.indexing.mode = 'stored-only';
  __putRecordForTests({
    id, owner: 'amir', domain: 'sales', yaml: serializeAsset(a), text: '', bytes: BACKFILL_BYTES.length,
    object: { key: `amir/${name}`, contentType: 'application/pdf', bytes: BACKFILL_BYTES.length },
    history: [{ version: 'v1', hash: '00000000', at: a.provenance.addedAt, bytes: BACKFILL_BYTES.length }],
    updatedAt: a.provenance.addedAt,
  });
  await putBlob(`amir/${name}`, BACKFILL_BYTES, 'application/pdf');
}

/** Unit deps over the REAL store and the REAL extractor, with a scripted parser. */
function backfillDeps(convert: () => Promise<DoclingOutcome>, seen: { parsed: string[]; indexed: { id: string; text: string }[] }): UnitDeps {
  return {
    body: bodyForIndex,
    index: async (a, text) => { seen.indexed.push({ id: a.id, text }); return report({ fileId: a.id, chunkIds: [`${a.id}#0`] }); },
    prune: async () => true,
    extract: (id) => extractFileText(id, {
      convert: async (doc) => { seen.parsed.push(doc.name); return convert(); },
      getBlob,
      index: async () => undefined,
    }),
  };
}

test('BACKFILL (plan): an old empty-text PDF is planned as missing-representation; policy / choice stored-only files are not units at all', async () => {
  __resetStore(); __resetBlobs(); __resetExtractFlights();
  await legacyPdf('as_old', 'old-invoice.pdf');
  await legacyPdf('as_secret', 'payroll.pdf', { sensitivity: 'restricted' });
  const optedOut = createFile(OWNER, { name: 'diary.md', text: 'private', indexing: 'stored-only' });
  const searchable = createFile(OWNER, { name: 'notes.md', text: 'ordinary indexed text' });

  const plan = await planReindex(ADMIN, { filter: 'marked', deps: deps({ storedUnits: storedFileUnits, readSnapshot: async () => snapshot({ rowsTotal: 0, rowsByUnit: new Map() }) }) });
  const byId = new Map(plan.units.map((u) => [u.id, u]));
  assert.deepEqual(byId.get('as_old')?.reasons, ['missing-representation'], 'the default `marked` filter picks the old PDF up');
  assert.equal(byId.has('as_secret'), false, 'a restricted file is never a unit');
  assert.equal(byId.has(optedOut.id), false, 'an owner’s opt-out is never a unit');
  assert.equal(byId.has(searchable.id), true);
});

test('BACKFILL (unit): the old PDF’s text is read from its stored bytes, stored on the file, then indexed by the strict path', async () => {
  __resetStore(); __resetBlobs(); __resetExtractFlights();
  await legacyPdf('as_old', 'old-invoice.pdf');
  const seen = { parsed: [] as string[], indexed: [] as { id: string; text: string }[] };
  const out = await reindexOneFile('as_old', 'u_admin', backfillDeps(async () => ({ ok: true, text: BACKFILL_TEXT, seconds: 1 }), seen));
  assert.deepEqual(out, { outcome: 'replaced' });
  assert.deepEqual(seen.parsed, ['old-invoice.pdf']);
  assert.deepEqual(seen.indexed, [{ id: 'as_old', text: BACKFILL_TEXT }], 'indexed once, with the extracted text');
  const view = getFile('as_old', OWNER);
  assert.equal(view.text, BACKFILL_TEXT, 'get_file now returns the document’s text');
  assert.equal(view.asset.indexing.mode, 'indexed');
});

test('BACKFILL (unit): a restricted file and an owner’s opt-out are skipped — the parser is never called, nothing is indexed', async () => {
  __resetStore(); __resetBlobs(); __resetExtractFlights();
  await legacyPdf('as_secret', 'payroll.pdf', { sensitivity: 'restricted' });
  await legacyPdf('as_choice', 'diary.pdf');
  setIndexingMode('as_choice', OWNER, 'stored-only'); // the owner says so explicitly
  const seen = { parsed: [] as string[], indexed: [] as { id: string; text: string }[] };
  const d = backfillDeps(async () => ({ ok: true, text: BACKFILL_TEXT, seconds: 1 }), seen);
  for (const id of ['as_secret', 'as_choice']) {
    const out = await reindexOneFile(id, 'u_admin', d);
    assert.equal(out.outcome, 'skipped', id);
    assert.match(out.reason ?? '', /stored-only/, id);
    assert.equal(getFile(id, OWNER).text, '', id);
    assert.equal(getFile(id, OWNER).asset.indexing.mode, 'stored-only', id);
  }
  assert.deepEqual(seen, { parsed: [], indexed: [] });
});

test('BACKFILL (unit): a document the parser finds no text in FAILS with that reason and stays stored-only; the run goes on', async () => {
  __resetStore(); __resetBlobs(); __resetExtractFlights();
  await legacyPdf('as_scan', 'scan.pdf');
  const seen = { parsed: [] as string[], indexed: [] as { id: string; text: string }[] };
  const out = await reindexOneFile('as_scan', 'u_admin', backfillDeps(
    async () => ({ ok: false, code: 'no-text', reason: 'The document parser (Docling) read the document and found no text in it.', seconds: 2 }), seen));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason ?? '', /found no text/);
  assert.deepEqual(seen.indexed, [], 'nothing invented, nothing indexed');
  const a = getFile('as_scan', OWNER).asset;
  assert.equal(a.indexing.mode, 'stored-only');
  assert.equal(a.indexing.extraction?.code, 'no-text', 'and the preview now shows why');
});

test('BACKFILL (unit): the parser going away MID-RUN is the typed refusal that stops the job — not a per-file shrug', async () => {
  __resetStore(); __resetBlobs(); __resetExtractFlights();
  await legacyPdf('as_old', 'old-invoice.pdf');
  const seen = { parsed: [] as string[], indexed: [] as { id: string; text: string }[] };
  await assert.rejects(
    () => reindexOneFile('as_old', 'u_admin', backfillDeps(
      async () => ({ ok: false, code: 'parser-unreachable', reason: 'The document parser (Docling) at http://docling:5001 could not be reached (ECONNREFUSED).', seconds: 0 }), seen)),
    (e: unknown) => isOfflineMockRefused(e) && /old-invoice\.pdf/.test((e as Error).message),
  );
  assert.deepEqual(seen.indexed, []);
  assert.equal(getFile('as_old', OWNER).text, '');
});

test('BACKFILL: the live unit path extracts WITHOUT the best-effort indexer, so the strict index is the only writer', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, 'reindex.ts'), 'utf8');
  assert.match(src, /extract: \(id\) => extractFileText\(id, \{ \.\.\.LIVE_EXTRACT_DEPS, index: async \(\) => undefined \}, \{ waitMs: BACKFILL_EXTRACT_WAIT_MS \}\)/);
});
