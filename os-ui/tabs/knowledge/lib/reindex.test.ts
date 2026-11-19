/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Knowledge re-index — the corpus agents cite, re-chunked and re-embedded
 * USER STORY: As a platform admin I need the hash vectors in the Knowledge index replaced through
 *             the real gateway, a refusal rather than a re-hash when the gateway is down, and a
 *             guarantee that a workflow whose rewrite failed keeps the units it already had.
 * ARCHITECTURE:
 *   - Offline: the probe, the index read and the per-unit work are injected; `globalThis.fetch` is
 *     stubbed where the real OpenSearch wiring is under test.
 *   - Two structural tripwires cover what an injected test cannot: that the default unit path is
 *     the governed `indexWorkflow`/`indexDomain` pipeline, and that `index-pipeline.ts` ADDS
 *     before it prunes (and prunes nothing when the add did not land).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  LOOSE_DOC_CAP,
  MARKER_FIELDS,
  STANDIN_MARKERS,
  looseQuery,
  looseUnitOf,
  markedQuery,
  missingVectorQuery,
  planReindex,
  reindexOneUnit,
  runReindex,
  knowledgeReindexService,
  __resetKnowledgeReindex,
  type KnowledgeReindexDeps,
  type UnitDeps,
} from '@tabs/knowledge/lib/reindex';
import { __resetReindexJobs, jobFor, type EngineProbe, type IndexSnapshot, type ReindexPlan } from '@core/kernel/reindex';
import { isOfflineMockRefused } from '@core/kernel/offline-mock';

const ADMIN = { id: 'u_admin', domains: ['sales'], role: 'admin' as const };
const CREATOR = { id: 'u_c', domains: ['sales'], role: 'creator' as const };

const UP: EngineProbe[] = [{ name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: true, detail: null }];
const DOWN: EngineProbe[] = [{ name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: false, detail: 'ECONNREFUSED' }];

beforeEach(() => {
  __resetReindexJobs();
  __resetKnowledgeReindex();
});

// ---------------------------------------------------------------------------
//  What is detectable
// ---------------------------------------------------------------------------

test('KNOWLEDGE REINDEX: the marked query covers the `source` keyword this index really persists', () => {
  const json = JSON.stringify(markedQuery());
  assert.ok(json.includes('"source"'), 'the knowledge index does carry a source — so the query is meaningful here');
  assert.ok(json.includes('offline-hash'));
  const q = markedQuery() as { bool: { should: unknown[] } };
  assert.equal(q.bool.should.length, MARKER_FIELDS.length * STANDIN_MARKERS.length * 2);
});

test('KNOWLEDGE REINDEX: missing-vector looks at `embedding`, not `vector`', () => {
  assert.deepEqual(missingVectorQuery(), { bool: { must_not: [{ exists: { field: 'embedding' } }] } });
});

test('KNOWLEDGE REINDEX: loose rows are the ones with no workflow scope', () => {
  assert.deepEqual(looseQuery(), { bool: { must_not: [{ exists: { field: 'workflow_id' } }] } });
  const combined = looseQuery({ term: { x: 1 } }) as { bool: { must: unknown[]; must_not: unknown[] } };
  assert.deepEqual(combined.bool.must, [{ term: { x: 1 } }]);
  assert.deepEqual(combined.bool.must_not, [{ exists: { field: 'workflow_id' } }]);
});

test('KNOWLEDGE REINDEX: a domain-card SECTION rolls up into the card; a pasted doc is its own unit', () => {
  const section = looseUnitOf('domain:sales:overview', { domain: 'sales', title: 'sales — Overview' });
  assert.equal(section.unit, 'domain:sales', 'one unit per card, not per section');
  assert.match(section.label, /domain card · sales/);

  const pasted = looseUnitOf('abc123', { title: 'Pricing memo' });
  assert.equal(pasted.unit, 'doc:abc123');
  assert.equal(pasted.label, 'Pricing memo');

  const untitled = looseUnitOf('xyz', {});
  assert.equal(untitled.label, 'xyz', 'an untitled row is still identifiable');
  assert.equal(LOOSE_DOC_CAP, 500);
});

// ---------------------------------------------------------------------------
//  plan
// ---------------------------------------------------------------------------

function snapshot(over: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return {
    reachable: true, rowsTotal: 0, mappingDim: 384, rowsMarked: 0, rowsMissingVector: 0,
    rowsByUnit: new Map(), unitsMarked: new Set(), unitsMissingVector: new Set(), looseDocs: [], truncated: false,
    ...over,
  };
}

function deps(over: Partial<KnowledgeReindexDeps> = {}): KnowledgeReindexDeps {
  return {
    probeEngines: async () => UP,
    readSnapshot: async () => snapshot(),
    storedUnits: () => [],
    reindexUnit: async () => ({ outcome: 'replaced' }),
    ...over,
  };
}

test('PLAN (knowledge): a workflow with marked rows, a pasted doc with no vector, and a clean one', async () => {
  const plan = await planReindex(ADMIN, {
    filter: 'marked',
    deps: deps({
      storedUnits: () => [
        { id: 'wf_1', label: 'Onboarding' },
        { id: 'wf_2', label: 'Pricing' },
        { id: 'domain:sales', label: 'domain card · sales' },
      ],
      readSnapshot: async () =>
        snapshot({
          rowsTotal: 41, rowsMarked: 5, rowsMissingVector: 1,
          rowsByUnit: new Map([['wf_1', 5], ['wf_2', 32], ['domain:sales', 3], ['doc:abc', 1]]),
          unitsMarked: new Set(['wf_1']),
          unitsMissingVector: new Set(['doc:abc']),
          looseDocs: [{ id: 'doc:abc', label: 'Pasted memo' }],
        }),
    }),
  });
  assert.equal(plan.target, 'knowledge');
  assert.deepEqual(plan.counts, {
    marked: 5, 'missing-vector': 1, 'missing-representation': 0, 'dimension-mismatch': 0, all: 41,
  });
  assert.deepEqual(plan.units.map((u) => u.id).sort(), ['doc:abc', 'wf_1']);
  assert.ok(plan.unmarkedCaveat.length > 0);
});

test('PLAN (knowledge): the gateway is the only engine, and when it is down the plan is not ready', async () => {
  const plan = await planReindex(ADMIN, { filter: 'all', deps: deps({ probeEngines: async () => DOWN }) });
  assert.equal(plan.engines.length, 1, 'no document parser on this corpus');
  assert.equal(plan.ready, false);
  assert.match(plan.blockedReason!, /embeddings gateway/);
});

test('PLAN (knowledge): admin-only', async () => {
  await assert.rejects(
    () => planReindex(CREATOR, { filter: 'marked', deps: deps() }),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

// ---------------------------------------------------------------------------
//  run
// ---------------------------------------------------------------------------

const PLAN_OF = (ids: string[]): ReindexPlan => ({
  target: 'knowledge',
  filter: 'marked',
  counts: { marked: ids.length, 'missing-representation': 0, 'missing-vector': 0, 'dimension-mismatch': 0, all: ids.length },
  units: ids.map((id) => ({ id, label: id, reasons: ['marked'], rows: 1 })),
  rowsTotal: ids.length,
  mappingDim: 384,
  configuredDim: 384,
  engines: UP,
  ready: true,
  blockedReason: null,
  unmarkedCaveat: 'caveat',
  truncated: false,
});

test('RUN (knowledge): the gateway is down ⇒ ENGINE_UNAVAILABLE, and NO row is touched', async () => {
  const touched: string[] = [];
  await assert.rejects(
    () =>
      runReindex(ADMIN, PLAN_OF(['wf_1']), {
        deps: deps({
          probeEngines: async () => DOWN,
          reindexUnit: async (id) => {
            touched.push(id);
            return { outcome: 'replaced' };
          },
        }),
      }),
    (e: unknown) => {
      assert.ok(isOfflineMockRefused(e));
      assert.match((e as Error).message, /A hash of the text is not an embedding/);
      assert.match((e as Error).message, /Nothing was read, replaced or deleted/);
      return true;
    },
  );
  assert.deepEqual(touched, []);
  assert.equal(jobFor('knowledge'), null);
});

test('RUN (knowledge): replaces the planned units, is bounded, and resumes at the cursor', async () => {
  const seen: string[] = [];
  const d = deps({
    reindexUnit: async (id) => {
      seen.push(id);
      return { outcome: 'replaced' };
    },
  });
  const plan = PLAN_OF(['wf_1', 'wf_2', 'domain:sales']);
  const first = await runReindex(ADMIN, plan, { batch: 2, deps: d });
  assert.equal(first.job.cursor, 2);
  assert.equal(first.job.status, 'running');
  const second = await runReindex(ADMIN, plan, { batch: 2, deps: d });
  assert.equal(second.started, false);
  assert.equal(second.job.status, 'done');
  assert.deepEqual(seen, ['wf_1', 'wf_2', 'domain:sales']);
});

test('RUN (knowledge): one job per target — Files may run at the same time, Knowledge may not run twice', async () => {
  let concurrent: { started: boolean; reason?: string } | null = null;
  const d = deps({ reindexUnit: async () => ({ outcome: 'replaced' }) });
  await runReindex(ADMIN, PLAN_OF(['a', 'b']), {
    batch: 1,
    deps: d,
    onProgress: async () => {
      if (!concurrent) concurrent = await runReindex(ADMIN, PLAN_OF(['a', 'b']), { batch: 1, deps: d });
    },
  });
  assert.equal(concurrent!.started, false);
  assert.equal(concurrent!.reason, 'already-running');
  assert.equal(jobFor('files'), null, 'the other target was never claimed');
});

// ---------------------------------------------------------------------------
//  One unit: three kinds, and the verdict that refuses a stand-in
// ---------------------------------------------------------------------------

const WF = {
  record: { id: 'wf_1', owner: 'amir', domain: 'sales', tacit: 'tacit', updatedAt: '2026-01-01T00:00:00Z', title: 'Onboarding' },
  workflow: { id: 'wf_1', title: 'Onboarding' },
};

function unitDeps(over: Partial<UnitDeps> = {}): UnitDeps {
  return {
    record: (() => WF) as unknown as UnitDeps['record'],
    domainCard: ((domain: string) => ({ domain, sections: [{ id: 's1', title: 'Overview', content: 'real content' }], updatedAt: 'x' })) as unknown as UnitDeps['domainCard'],
    indexWorkflow: (async () => ({ units: 4, store: 'opensearch', embedSource: 'litellm', scope: 'wf_1' })) as unknown as UnitDeps['indexWorkflow'],
    indexDomain: (async () => ({ units: 2, store: 'opensearch', embedSource: 'litellm', scope: 'domain:sales' })) as unknown as UnitDeps['indexDomain'],
    embed: (async () => ({ vectors: [[0.1, 0.2]], source: 'litellm' })) as unknown as UnitDeps['embed'],
    readDoc: async () => ({ text: 'the pasted text' }),
    writeDocVector: async () => true,
    ...over,
  };
}

test('UNIT (knowledge): a workflow re-chunked and re-embedded live ⇒ replaced', async () => {
  assert.deepEqual(await reindexOneUnit('wf_1', 'u_admin', unitDeps()), { outcome: 'replaced' });
});

test('UNIT (knowledge): an offline-hash embedding is a FAILURE — nothing is replaced', async () => {
  const out = await reindexOneUnit('wf_1', 'u_admin', unitDeps({
    indexWorkflow: (async () => ({ units: 4, store: 'opensearch', embedSource: 'offline-hash', scope: 'wf_1' })) as unknown as UnitDeps['indexWorkflow'],
  }));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /stand-in \(offline-hash\)/);
});

test('UNIT (knowledge): an in-memory-only write is a FAILURE, not a success', async () => {
  const out = await reindexOneUnit('wf_1', 'u_admin', unitDeps({
    indexWorkflow: (async () => ({ units: 4, store: 'memory', embedSource: 'litellm', scope: 'wf_1' })) as unknown as UnitDeps['indexWorkflow'],
  }));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /did not land/);
  assert.match(out.reason!, /existing rows stand/);
});

test('UNIT (knowledge): a workflow that is gone is SKIPPED', async () => {
  const out = await reindexOneUnit('wf_x', 'u_admin', unitDeps({ record: (() => null) as unknown as UnitDeps['record'] }));
  assert.equal(out.outcome, 'skipped');
  assert.match(out.reason!, /no longer stored/);
});

test('UNIT (knowledge): a domain card is re-indexed; an EMPTY card is skipped, not failed', async () => {
  assert.deepEqual(await reindexOneUnit('domain:sales', 'u_admin', unitDeps()), { outcome: 'replaced' });
  const empty = await reindexOneUnit('domain:sales', 'u_admin', unitDeps({
    domainCard: ((domain: string) => ({ domain, sections: [{ id: 's', title: 'T', content: '  ' }], updatedAt: 'x' })) as unknown as UnitDeps['domainCard'],
  }));
  assert.equal(empty.outcome, 'skipped');
  assert.match(empty.reason!, /nothing to index/);
});

test('UNIT (knowledge): a pasted doc is re-embedded IN PLACE, and only after a live embedding', async () => {
  const wrote: { id: string; vector: number[] }[] = [];
  const out = await reindexOneUnit('doc:abc', 'u_admin', unitDeps({
    writeDocVector: async (id, vector) => {
      wrote.push({ id, vector });
      return true;
    },
  }));
  assert.deepEqual(out, { outcome: 'replaced' });
  assert.deepEqual(wrote, [{ id: 'abc', vector: [0.1, 0.2] }], 'the row is updated, never deleted and re-created');
});

test('UNIT (knowledge): a pasted doc whose embedding came back as a hash is NOT written', async () => {
  const wrote: string[] = [];
  const out = await reindexOneUnit('doc:abc', 'u_admin', unitDeps({
    embed: (async () => ({ vectors: [[0.1]], source: 'offline-hash' })) as unknown as UnitDeps['embed'],
    writeDocVector: async (id) => {
      wrote.push(id);
      return true;
    },
  }));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /left as it was/);
  assert.deepEqual(wrote, [], 'a hash vector must never be written by the tool that removes hash vectors');
});

test('UNIT (knowledge): a pasted doc with no text left is SKIPPED', async () => {
  const out = await reindexOneUnit('doc:abc', 'u_admin', unitDeps({ readDoc: async () => null }));
  assert.equal(out.outcome, 'skipped');
  assert.match(out.reason!, /holds no text/);
});

test('UNIT (knowledge): an OpenSearch update that was refused leaves the row unchanged and fails', async () => {
  const out = await reindexOneUnit('doc:abc', 'u_admin', unitDeps({ writeDocVector: async () => false }));
  assert.equal(out.outcome, 'failed');
  assert.match(out.reason!, /row is unchanged/);
});

// ---------------------------------------------------------------------------
//  Structural tripwires
// ---------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'reindex.ts'), 'utf8');
const PIPELINE = readFileSync(join(HERE, 'index-pipeline.ts'), 'utf8');

test('TRIPWIRE (knowledge): the default unit path is the governed index pipeline, not a copy of it', () => {
  assert.match(SRC, /indexWorkflow,\n\s*indexDomain,/, 'the live deps ARE the pipeline functions');
  assert.match(SRC, /refuseOfflineMock\(/);
  assert.ok(!/offlineMockAllowed\(/.test(SRC), 'a re-index may never opt INTO fabrication');
});

test('TRIPWIRE: the knowledge pipeline ADDS before it prunes, and prunes nothing when the add failed', () => {
  const bulk = PIPELINE.indexOf('_bulk?refresh=true');
  const prune = PIPELINE.indexOf('await pruneScopeExcept(');
  assert.ok(bulk > 0 && prune > bulk, 'the delete-by-query must follow the bulk write, never precede it');
  assert.match(PIPELINE, /if \(!landed\) return false;\n\s*await pruneScopeExcept\(/, 'a failed add prunes nothing');
  assert.match(PIPELINE, /if \(keepIds\.length === 0\) return false;/, 'and it can never prune to nothing');
});

test('KNOWLEDGE REINDEX: the exported service is the contract both doors use', () => {
  assert.equal(typeof knowledgeReindexService.planReindex, 'function');
  assert.equal(typeof knowledgeReindexService.runReindex, 'function');
});
