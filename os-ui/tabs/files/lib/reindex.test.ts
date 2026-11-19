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
  MARKER_FIELDS,
  STANDIN_MARKERS,
  markedQuery,
  missingVectorQuery,
  mappingDimension,
  readFilesSnapshot,
  reindexOneFile,
  planReindex,
  runReindex,
  filesReindexService,
  __resetFilesReindex,
  type FilesReindexDeps,
  type UnitDeps,
} from '@tabs/files/lib/reindex';
import { __resetReindexJobs, jobFor, type EngineProbe, type IndexSnapshot } from '@core/kernel/reindex';
import { isOfflineMockRefused } from '@core/kernel/offline-mock';
import { emptyAsset, type FileAsset } from '@tabs/files/lib/asset-schema';
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
    /indexAsset\(asset, text, \{ live: true, reembed: true, awaitMirror: true, caller \}\)/,
    'reembed empties the hash-vector cache; awaitMirror is what makes the prune safe',
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
