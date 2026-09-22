/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDelegated, trustOf, freshnessOf, authorityOf, rerank, toPassages } from './retrieve-rank.ts';
import type { Hit, ChunkMeta } from './index-store.ts';

function hit(over: Partial<Hit> & { meta?: Partial<ChunkMeta> } = {}): Hit {
  const meta: ChunkMeta = {
    owner: 'amir', tier: 'dataset', domain: 'sales', grantedUsers: [],
    name: 'f.pdf', deepLink: 's3://files/amir/f.pdf', kind: 'doc', tags: [], freshness: null,
    ...over.meta,
  };
  return { fileId: 'as_1', chunkId: 'as_1#0', repType: 'text', text: 'some passage text', score: 1, semantic: 0.5, lexical: 1, ...over, meta };
}

test('assertDelegated rejects a missing/service identity (R2)', () => {
  assert.throws(() => assertDelegated(null), /delegated/);
  assert.throws(() => assertDelegated({}), /delegated/);
  assert.doesNotThrow(() => assertDelegated({ id: 'amir' }));
});

test('trust ranks product > asset > dataset', () => {
  assert.ok(trustOf('product') > trustOf('asset'));
  assert.ok(trustOf('asset') > trustOf('dataset'));
});

test('freshness decays over a year; missing → 0', () => {
  const now = Date.parse('2026-06-30T00:00:00Z');
  assert.equal(freshnessOf(null, now), 0);
  assert.ok(freshnessOf('2026-06-29T00:00:00Z', now) > freshnessOf('2026-01-01T00:00:00Z', now));
});

test('authority boosts files in the reader’s own domain', () => {
  assert.equal(authorityOf('sales', { id: 'a', domains: ['sales'] }), 0.1);
  assert.equal(authorityOf('ops', { id: 'a', domains: ['sales'] }), 0);
});

test('rerank lifts a fresher, more-trusted passage above a bare lexical match', () => {
  const reader = { id: 'amir', domains: ['sales'] };
  const now = Date.parse('2026-06-30T00:00:00Z');
  const stale = hit({ fileId: 'old', score: 1.2, meta: { tier: 'dataset', freshness: '2025-01-01T00:00:00Z' } });
  const trusted = hit({ fileId: 'prod', score: 1.0, meta: { tier: 'product', domain: 'sales', freshness: '2026-06-29T00:00:00Z' } });
  const ranked = rerank([stale, trusted], reader, now);
  assert.equal(ranked[0].fileId, 'prod', 'trust + freshness + authority overtakes raw score');
});

test('toPassages cites the file and flags media open-original (never calls STACKIT)', () => {
  const reader = { id: 'amir', domains: ['sales'] };
  const audio = hit({ fileId: 'aud', repType: 'transcript', meta: { kind: 'audio', name: 'call.m4a' } });
  const passages = toPassages(rerank([audio], reader), { openOriginal: true, visionFlag: true });
  assert.equal(passages[0].name, 'call.m4a');
  assert.equal(passages[0].repType, 'transcript');
  assert.equal(passages[0].openOriginal?.vision, 'flagged-stackit');
});
