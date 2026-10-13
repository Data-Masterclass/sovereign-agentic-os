/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type KnowledgeUnit, type Provenance } from './chunk.ts';
import { canSee, applyDls, lexicalScore, hybridScore, freshness, rerank } from './retrieve-core.ts';

const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const beaBuilder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const kenji = { id: 'kenji', domains: ['finance'], role: 'creator' as const };

function prov(over: Partial<Provenance>): Provenance {
  return {
    domain: 'sales', workflowId: 'w', stepId: null, type: 'workflow', actor: null,
    owner: 'amir', version: '1', visibility: 'Personal', updatedAt: new Date().toISOString(),
    trust: 0.5, authority: 0.5, ...over,
  };
}
function unit(id: string, text: string, over: Partial<Provenance>): KnowledgeUnit {
  return { id, title: id, text, provenance: prov(over) };
}

test('DLS: owner sees own Personal unit; others in domain do not (unless builder/admin)', () => {
  const u = prov({ visibility: 'Personal', owner: 'amir' });
  assert.equal(canSee(u, amir), true);
  assert.equal(canSee(u, beaBuilder), true); // builder in same domain
  assert.equal(canSee(prov({ visibility: 'Personal', owner: 'amir' }), kenji), false);
});

test('DLS: Shared visible inside domain, not cross-domain', () => {
  const u = prov({ visibility: 'Shared', owner: 'amir' });
  assert.equal(canSee(u, beaBuilder), true);
  assert.equal(canSee(u, kenji), false);
});

test('DLS: Marketplace visible to everyone', () => {
  assert.equal(canSee(prov({ visibility: 'Marketplace' }), kenji), true);
});

test('applyDls filters out non-granted units (the query-time grant filter)', () => {
  const units = [
    unit('a', 'x', { visibility: 'Shared', owner: 'amir' }),
    unit('b', 'y', { visibility: 'Personal', owner: 'someone-else' }),
    unit('c', 'z', { visibility: 'Marketplace' }),
  ];
  const seen = applyDls(units, kenji).map((u) => u.id);
  assert.deepEqual(seen, ['c']); // only marketplace for a finance participant
});

test('lexicalScore rewards term overlap', () => {
  assert.ok(lexicalScore('bank portal', 'submit to the bank portal now') > 0);
  assert.equal(lexicalScore('bank portal', 'totally unrelated text'), 0);
});

test('hybridScore blends dense + lexical by weight', () => {
  assert.ok(Math.abs(hybridScore(1, 0, 0.6) - 0.6) < 1e-9);
  assert.ok(Math.abs(hybridScore(0, 1, 0.6) - 0.4) < 1e-9);
});

test('freshness decays with age', () => {
  const now = Date.parse('2026-06-30T00:00:00Z');
  const fresh = freshness('2026-06-29T00:00:00Z', now);
  const stale = freshness('2025-06-30T00:00:00Z', now);
  assert.ok(fresh > stale);
});

test('rerank promotes trust + authority on a relevance tie', () => {
  const a = { unit: unit('a', 't', { trust: 0.9, authority: 1.0 }), relevance: 0.5 };
  const b = { unit: unit('b', 't', { trust: 0.2, authority: 0.4 }), relevance: 0.5 };
  const ranked = rerank([b, a]);
  assert.equal(ranked[0].unit.id, 'a');
});

test('rerank still respects a clear relevance win', () => {
  const a = { unit: unit('a', 't', { trust: 0.1, authority: 0.1 }), relevance: 0.95 };
  const b = { unit: unit('b', 't', { trust: 0.9, authority: 0.9 }), relevance: 0.1 };
  const ranked = rerank([b, a]);
  assert.equal(ranked[0].unit.id, 'a');
});
