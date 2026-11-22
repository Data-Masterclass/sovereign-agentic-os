/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Files and Knowledge: scope, honesty and the OpenSearch cross-check.
 * USER STORY: As a creator I see my own files and workflows only; as anyone I am told when OpenSearch
 *             does not answer instead of being shown 0 rows; an admin alone gets index-wide search latency.
 * ARCHITECTURE: the OpenSearch reads are recorders (real-container proof: core/adapters/opensearch/
 *   index-stats.int.test.ts). Tested here: which ids are asked, the verdicts, and the unavailable path.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
const asked: { ids?: string[]; index?: string; counters: number } = { counters: 0 };
let osDown = false;
let rowsFor: Record<string, { rows: number; newest: string | null }> = {};

mock.module('@core/adapters/opensearch/index-stats', {
  namedExports: {
    ...(await real('@core/adapters/opensearch/index-stats')),
    unitRowStats: async (index: string, _f: string, ids: string[]) => {
      asked.ids = ids; asked.index = index;
      if (osDown) return { ok: false, reason: 'unreachable', detail: 'OpenSearch did not answer', at: '' };
      // OpenSearch answers about a foreign unit anyway: the panel must drop it.
      return { ok: true, at: '', value: new Map(Object.entries({ ...rowsFor, foreign: { rows: 9, newest: null } }).filter(([k]) => ids.includes(k) || k === 'foreign')) };
    },
    indexSearchCounters: async () => { asked.counters += 1; return { ok: true, at: '', value: { queries: 4, totalMs: 100 } }; },
  },
});

const { registerMonitoringSources } = await import('./sources');
const { filesView } = await import('./files-panel');
const { knowledgeView } = await import('./knowledge-panel');

const ex = (status: 'extracted' | 'failed', code?: string) => ({ status, code, reason: code ? 'Docling said no' : undefined, at: '2026-11-20T10:00:00Z' });
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  files: async (p) => {
    const mine = [
      { id: 'f-ok', name: 'plan.pdf', domain: 'sales', scope: 'mine' as const, kind: 'doc', bytes: 10, mode: 'indexed' as const, extraction: ex('extracted'), outcome: { status: 'indexed' as const, chunks: 3 } },
      { id: 'f-bad', name: 'scan.pdf', domain: 'sales', scope: 'mine' as const, kind: 'doc', bytes: 10, mode: 'indexed' as const, extraction: ex('failed', 'parser-unreachable'), outcome: { status: 'failed' as const, reason: 'no text' } },
      { id: 'f-lost', name: 'lost.md', domain: 'sales', scope: 'mine' as const, kind: 'doc', bytes: 10, mode: 'indexed' as const, extraction: null, outcome: { status: 'indexed' as const, chunks: 2 } },
    ];
    return p.role === 'admin' ? [...mine, { id: 'f-hr', name: 'salaries.xlsx', domain: 'hr', scope: 'domain' as const, kind: 'table', bytes: 1, mode: 'stored-only' as const, extraction: null, outcome: null }] : mine;
  },
  knowledge: async (p) => {
    const mine = [
      { id: 'wf-live', title: 'Refunds', domain: 'sales', scope: 'mine' as const, status: 'live' as const, updatedAt: '2026-11-10T00:00:00Z', publishedAt: '2026-11-10T00:00:00Z', certified: false },
      { id: 'wf-stale', title: 'Onboarding', domain: 'sales', scope: 'mine' as const, status: 'live' as const, updatedAt: '2026-11-15T00:00:00Z', publishedAt: null, certified: false },
      { id: 'wf-none', title: 'Escalation', domain: 'sales', scope: 'mine' as const, status: 'live' as const, updatedAt: '2026-11-10T00:00:00Z', publishedAt: null, certified: false },
      { id: 'wf-draft', title: 'Draft idea', domain: 'sales', scope: 'mine' as const, status: 'draft' as const, updatedAt: '2026-11-10T00:00:00Z', publishedAt: null, certified: false },
    ];
    return p.role === 'admin' ? [...mine, { id: 'wf-hr', title: 'Payroll run', domain: 'hr', scope: 'domain' as const, status: 'live' as const, updatedAt: '2026-11-10T00:00:00Z', publishedAt: null, certified: false }] : mine;
  },
});

const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;

beforeEach(() => {
  osDown = false; asked.counters = 0; asked.ids = undefined;
  rowsFor = { 'f-ok': { rows: 3, newest: null }, 'f-bad': { rows: 0, newest: null }, 'wf-live': { rows: 5, newest: '2026-11-11T00:00:00Z' }, 'wf-stale': { rows: 2, newest: '2026-11-12T00:00:00Z' } };
});

test('files: conversion and indexing status, failure code, and the OpenSearch cross-check', async () => {
  const v = await filesView(ada);
  const by = Object.fromEntries(v.files.map((f) => [f.id, f]));
  assert.equal(by['f-bad'].conversion, 'failed');
  assert.equal(by['f-bad'].conversionFailure!.code, 'parser-unreachable');
  assert.equal(by['f-bad'].indexing, 'failed');
  assert.equal(by['f-ok'].agreement, 'agrees');
  assert.equal(by['f-lost'].agreement, 'missing_in_index', 'recorded indexed, but OpenSearch holds no row');
  assert.equal(v.summary!.disagreements, 1);
  assert.equal(v.files[0].conversion === 'failed' || v.files[0].indexing === 'failed', true, 'attention first');
  assert.deepEqual(v.conversionFailuresByCode, { 'parser-unreachable': 1 });
  assert.ok(v.notUpstream.some((n) => /Trivy/.test(n.panel)), 'Trivy on uploads is said to be unavailable');
});

test('files scope: a creator’s OpenSearch read names only their files; foreign rows and files never appear', async () => {
  const v = await filesView(ada);
  assert.ok(!asked.ids!.includes('f-hr'));
  assert.ok(!JSON.stringify(v).includes('salaries') && !JSON.stringify(v).includes('foreign'));
  const a = await filesView(admin);
  assert.ok(a.files.some((f) => f.id === 'f-hr'));
});

test('files: OpenSearch down → unavailable with its reason, row counts absent (never 0)', async () => {
  osDown = true;
  const v = await filesView(ada);
  assert.equal(v.sources.openSearch.state, 'unavailable');
  assert.ok(v.files.every((f) => !('openSearchRows' in f) && f.agreement === 'unknown'));
  assert.equal(v.sources.inventory.state, 'live');
});

test('knowledge: indexed, stale, published-but-not-indexed and draft come from OpenSearch’s rows and ingest time', async () => {
  const v = await knowledgeView(ada);
  const st = Object.fromEntries(v.workflows.map((w) => [w.id, w.index!.state]));
  assert.deepEqual(st, { 'wf-live': 'indexed', 'wf-stale': 'stale', 'wf-none': 'not_indexed', 'wf-draft': 'draft_not_indexed' });
  assert.equal(v.workflows[0].index!.state, 'not_indexed', 'worst first');
  assert.equal(asked.index, 'knowledge');
  assert.ok(v.notUpstream.some((n) => /Zero-result/.test(n.panel)));
});

test('knowledge scope: a creator never asks about, or receives, another domain’s workflow; search latency is admin-only', async () => {
  const v = await knowledgeView(ada);
  assert.ok(!asked.ids!.includes('wf-hr'));
  assert.ok(!JSON.stringify(v).includes('Payroll'));
  assert.equal('searchLatency' in v, false);
  assert.equal(asked.counters, 0, 'the index-wide counters are not even read for a creator');
  const a = await knowledgeView(admin);
  assert.deepEqual(a.searchLatency, { queries: 4, avgMs: 25 });
  assert.ok(a.workflows.some((w) => w.id === 'wf-hr'));
});

test('knowledge: OpenSearch down → unavailable, no index field, no summary', async () => {
  osDown = true;
  const v = await knowledgeView(ada);
  assert.equal(v.sources.openSearch.state, 'unavailable');
  assert.ok(v.workflows.every((w) => !('index' in w)));
  assert.equal(v.summary, null);
});

test('the MCP door serves files and knowledge through the same functions', async () => {
  const { MONITORING_TOOLS } = await import('@core/mcp/monitoring-tools');
  const tool = MONITORING_TOOLS.find((t) => t.name === 'get_monitoring_panels')!;
  assert.equal(((await tool.call(ada, { view: 'files' })) as { view: string }).view, 'files');
  assert.equal(((await tool.call(ada, { view: 'knowledge' })) as { view: string }).view, 'knowledge');
});
