/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Files and Knowledge tell "the index does not exist" from "the index holds 0 rows".
 * USER STORY: As an operator I want a missing OpenSearch index to read "unavailable: index absent", and a
 *             file with no rows in an existing index to read "0 rows" — never the first as the second.
 * ARCHITECTURE: unitRowStats / indexSearchCounters are recorders answering what the real adapter returns
 *   (real-OpenSearch proof: core/adapters/opensearch/index-stats.int.test.ts and the stores test
 *   monitoring-files-knowledge.int.test.ts). Negative twin: index present, unit with no rows ⇒ 0 / missing_in_index.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
let absent = false;
const gone = (what: string) => ({ ok: false, reason: 'not_found', detail: `OpenSearch index "${what}" does not exist`, at: '' });

mock.module('@core/adapters/opensearch/index-stats', {
  namedExports: {
    ...(await real('@core/adapters/opensearch/index-stats')),
    unitRowStats: async (index: string) => (absent ? gone(index) : { ok: true, at: '', value: new Map() }),
    indexSearchCounters: async (index: string) => (absent ? gone(index) : { ok: true, at: '', value: { queries: 4, totalMs: 100 } }),
  },
});

const { registerMonitoringSources } = await import('./sources');
const { filesView } = await import('./files-panel');
const { knowledgeView } = await import('./knowledge-panel');
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  files: async () => [{ id: 'f1', name: 'a.md', domain: 'sales', scope: 'mine', kind: 'doc', bytes: 1, mode: 'indexed', extraction: null, outcome: { status: 'indexed', chunks: 2 } }],
  knowledge: async () => [{ id: 'w1', title: 'Refunds', domain: 'sales', scope: 'mine', status: 'live', updatedAt: '2026-11-10T00:00:00Z', publishedAt: '2026-11-10T00:00:00Z', certified: false }],
});
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'admin' } as never;
beforeEach(() => { absent = false; });

test('files: a missing index is unavailable with its name, not "0 rows" and not "not indexed"', async () => {
  absent = true;
  const v = await filesView(ada);
  assert.equal(v.sources.openSearch.state, 'unavailable');
  assert.match((v.sources.openSearch as { reason: string }).reason, /index "files" does not exist/);
  assert.equal('openSearchRows' in v.files[0], false);
  assert.equal(v.files[0].agreement, 'unknown');
  assert.equal(v.summary!.disagreements, 0);
});

test('files twin: index present, no rows for the file ⇒ live, 0 rows, a disagreement with the recorded outcome', async () => {
  const v = await filesView(ada);
  assert.equal(v.sources.openSearch.state, 'live');
  assert.equal(v.files[0].openSearchRows, 0);
  assert.equal(v.files[0].agreement, 'missing_in_index');
});

test('knowledge: a missing index is unavailable (no summary, no index field), never "not indexed"', async () => {
  absent = true;
  const v = await knowledgeView(ada);
  assert.equal(v.sources.openSearch.state, 'unavailable');
  assert.match((v.sources.openSearch as { reason: string }).reason, /index "knowledge" does not exist/);
  assert.equal(v.summary, null);
  assert.ok(v.workflows.every((w) => !('index' in w)));
});

test('knowledge: searchLatency on a missing index is unavailable with the reason, never absent or 0', async () => {
  absent = true;
  const v = await knowledgeView(admin);
  assert.equal('searchLatency' in v, false);
  assert.match(v.searchLatencyUnavailable!, /index "knowledge" does not exist/);
});

test('knowledge twin: index present ⇒ latency from the counters, workflow with no rows is "published but not indexed"', async () => {
  const v = await knowledgeView(admin);
  assert.deepEqual(v.searchLatency, { queries: 4, avgMs: 25 });
  assert.equal(v.searchLatencyUnavailable, undefined);
  assert.equal(v.workflows[0].index!.state, 'not_indexed');
  assert.equal(v.workflows[0].index!.rows, 0);
});
