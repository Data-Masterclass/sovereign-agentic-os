/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    Knowledge "hybrid" retrieval counts a dense hit WITHOUT a keyword match
 * USER STORY: As someone asking "how do I resign" I want the passage about the notice period found,
 *             though it never says "resign" — and never a unit outside my grants.
 * ARCHITECTURE:
 *   - Until 2026-11-20 the live query put BM25 in `must` and k-NN in `should`: no keyword, no
 *     result, whatever the vector said — and the dense score was then replaced by a constant 0.5.
 *     Now BM25 and k-NN run as two queries (both DLS-filtered) and are fused by rank (RRF).
 *   - `fetch` is faked: the gateway returns a real-dimension vector; OpenSearch answers per query
 *     shape; OPA is unreachable → its local mirror (sales is granted `retrieve`).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveKnowledge } from '@tabs/knowledge/lib/retrieve';
import { __resetIndex } from '@tabs/knowledge/lib/index-store';
import { config } from '@core/kernel/config';

const realFetch = globalThis.fetch;
const realFailOpen = config.opaFailOpen;
const sara = { id: 'sara', domains: ['sales'], role: 'creator' as const };

const src = (over: Record<string, unknown>) => ({
  domain: 'sales', workflow_id: 'wf_hr', type: 'workflow', owner: 'bea', version: '1', visibility: 'Shared',
  updated_at: new Date().toISOString(), trust: 0.7, authority: 0.7, ...over,
});
const NOTICE = { _id: 'u_notice', _score: 0.9, _source: src({ title: 'Leaving', text: 'Staff may leave the company after a notice period of four weeks.' }) };
const FOREIGN = { _id: 'u_foreign', _score: 0.8, _source: src({ domain: 'finance', visibility: 'Personal', owner: 'kenji', title: 'Exit', text: 'Finance-only exit terms.' }) };
const SPELLED = { _id: 'u_spelled', _score: 7.1, _source: src({ title: 'Resign', text: 'To resign, email your manager.' }) };

function fakeCluster(answer: { lexical: unknown[]; dense: unknown[]; rejectFilteredKnn?: boolean }, bodies: Record<string, unknown>[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/v1/embeddings')) {
      const v = new Array(config.embedDim).fill(0); v[0] = 1;
      return new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes(`/${config.knowledgeIndex}/_search`)) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      const s = JSON.stringify(body);
      if (answer.rejectFilteredKnn && body.query?.knn) return new Response('{"error":"no efficient filter"}', { status: 400 });
      const hits = s.includes('"knn"') ? answer.dense : answer.lexical;
      return new Response(JSON.stringify({ hits: { hits } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('offline'); // OPA → local mirror
  }) as typeof fetch;
}

beforeEach(() => { __resetIndex(); config.opaFailOpen = true; });
afterEach(() => { globalThis.fetch = realFetch; config.opaFailOpen = realFailOpen; });

test('DENSE-ONLY: a semantically relevant unit with no keyword match is found', async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = fakeCluster({ lexical: [], dense: [NOTICE, FOREIGN] }, bodies);
  const res = await retrieveKnowledge('how do I resign', sara);
  assert.equal(res.decision, 'allow');
  assert.equal(res.store, 'opensearch');
  assert.equal(res.mode, 'hybrid');
  const ids = res.hits.map((h) => h.unit.id);
  assert.deepEqual(ids, ['u_notice'], 'the dense hit counts; the cross-domain Personal unit is re-checked out');
  assert.ok(res.hits[0].relevance > 0, 'its relevance comes from its rank, not a constant');
  // No keyword gate: no query requires BM25 AND k-NN together, and both carry the DLS filter.
  for (const b of bodies) {
    const s = JSON.stringify(b);
    assert.ok(!(s.includes('"knn"') && s.includes('multi_match')), 'lexical and dense are separate queries');
    assert.match(s, /"owner":"sara"/);
  }
});

test('LEXICAL still found, and a unit found by both ranks above a single-list hit', async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = fakeCluster({ lexical: [SPELLED], dense: [NOTICE, SPELLED] }, bodies);
  const res = await retrieveKnowledge('how do I resign', sara);
  const ids = res.hits.map((h) => h.unit.id);
  assert.equal(ids[0], 'u_spelled', 'found by both halves → first');
  assert.ok(ids.includes('u_notice'), 'the dense-only unit is still in the list');
});

test('an engine that refuses a filter inside k-NN gets a post-filtered k-NN (DLS kept)', async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = fakeCluster({ lexical: [], dense: [NOTICE], rejectFilteredKnn: true }, bodies);
  const res = await retrieveKnowledge('how do I resign', sara);
  assert.deepEqual(res.hits.map((h) => h.unit.id), ['u_notice']);
  const first = bodies.find((b) => (b as { query: { knn?: unknown } }).query.knn) as { query: { knn: { embedding: { filter?: unknown } } } } | undefined;
  assert.ok(first?.query.knn.embedding.filter, 'the efficient (in-k-NN) filter is tried first');
  const post = bodies.find((b) => JSON.stringify(b).includes('"knn"') && !(b as { query: { knn?: unknown } }).query.knn);
  assert.ok(post && JSON.stringify(post).includes('"owner":"sara"'));
});
