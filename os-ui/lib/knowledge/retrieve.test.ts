/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * End-to-end `retrieveKnowledge` (the governed `search_knowledge` entry) over the
 * OFFLINE in-process index — no network. Proves the wiring the pure-core tests can't:
 *   • OPA gate first (an ungranted domain → deny, zero hits, no retrieval);
 *   • the allow path returns RANKED, NON-EMPTY hits that carry the provenance +
 *     text an agent needs to cite (consumable-as-context);
 *   • DLS scoping across the FULL pipeline — a cross-domain Personal unit is never
 *     returned, even though it sits in the same index.
 *
 * We drive `fetch` to unreachable so OPA falls to the built-in local mirror (sales
 * domain is granted `retrieve`) and OpenSearch is skipped → the retriever reads the
 * in-process mirror we seed with `upsertUnits`. This is the honest offline path that
 * also runs on a laptop; the LIVE hybrid path is the same code with OpenSearch up.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveKnowledge } from './retrieve.ts';
import { upsertUnits, __resetIndex, type IndexedUnit } from './index-store.ts';
import { hashEmbed } from './embed-core.ts';
import { config } from '../core/config.ts';
import type { Provenance } from './chunk.ts';

const realFetch = globalThis.fetch;
// Force OFFLINE: OPA + OpenSearch unreachable → local OPA mirror + in-process index.
beforeEach(() => {
  __resetIndex();
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function unit(over: Partial<Provenance> & { id: string; text: string; title?: string }): IndexedUnit {
  const prov: Provenance = {
    domain: 'sales', workflowId: 'wf1', stepId: null, type: 'workflow', actor: null,
    owner: 'sara', version: '1', visibility: 'Shared', updatedAt: new Date().toISOString(),
    trust: 0.7, authority: 0.7, ...over,
  };
  return {
    id: over.id, title: over.title ?? over.id, text: over.text, provenance: prov,
    embedding: hashEmbed(over.text, config.embedDim), indexedAt: new Date().toISOString(),
  };
}

test('OPA gate: a principal whose domain is not granted `retrieve` is denied (no hits)', async () => {
  upsertUnits('wf1', [unit({ id: 'a', text: 'refund policy for late orders', domain: 'sales' })]);
  const res = await retrieveKnowledge('refund policy', { id: 'x', domains: ['marketing'], role: 'creator' });
  assert.equal(res.decision, 'deny');
  assert.equal(res.hits.length, 0);
});

test('allow path returns ranked, non-empty hits with provenance + text to cite', async () => {
  upsertUnits('wf1', [
    unit({ id: 'a', text: 'the refund policy covers late orders within 30 days', title: 'Refund policy', domain: 'sales' }),
    unit({ id: 'b', text: 'unrelated note about office parking spaces', title: 'Parking', domain: 'sales' }),
  ]);
  const res = await retrieveKnowledge('refund policy late orders', { id: 'sara', domains: ['sales'], role: 'creator' });
  assert.equal(res.decision, 'allow');
  assert.ok(res.hits.length > 0, 'non-empty');
  // The refund unit must rank first (relevance), and carry a citable snippet + provenance.
  assert.equal(res.hits[0].unit.id, 'a');
  assert.ok(res.hits[0].unit.text.includes('refund'), 'snippet is the real text, not empty');
  assert.equal(res.hits[0].unit.provenance.domain, 'sales');
  assert.ok(typeof res.hits[0].score === 'number');
});

test('DLS: a cross-domain Personal unit is never returned by the full pipeline', async () => {
  upsertUnits('wf1', [
    unit({ id: 'mine', text: 'shared sales refund guidance', domain: 'sales', visibility: 'Shared' }),
    // A Personal unit owned by someone else in a DIFFERENT domain — must stay hidden.
    unit({ id: 'secret', text: 'refund secret from finance', domain: 'finance', owner: 'fred', visibility: 'Personal' }),
  ]);
  const res = await retrieveKnowledge('refund', { id: 'sara', domains: ['sales'], role: 'creator' });
  assert.equal(res.decision, 'allow');
  const ids = res.hits.map((h) => h.unit.id);
  assert.ok(ids.includes('mine'), 'sees own-domain Shared');
  assert.ok(!ids.includes('secret'), 'NEVER leaks the cross-domain Personal unit');
});
