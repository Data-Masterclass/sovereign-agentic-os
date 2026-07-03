/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetIndex, indexFile, removeFromIndex, indexSize, indexedHashes, priorVectorsByHash } from './index-store.ts';
import type { ChunkDoc } from './index-store.ts';

function doc(chunkId: string, fileId: string, hash = 'h1'): ChunkDoc {
  return {
    fileId, chunkId, repType: 'text', text: 'hello', hash, vector: [0.1, 0.2],
    meta: { owner: 'amir', tier: 'team', domain: 'sales', grantedUsers: [], name: 'doc.pdf', deepLink: '', kind: 'doc', tags: [], freshness: null },
  };
}

beforeEach(() => __resetIndex());

test('indexFile adds chunks; indexSize reflects count', () => {
  indexFile([doc('c1', 'f1'), doc('c2', 'f1', 'h2')], 'f1');
  assert.equal(indexSize(), 2);
});

test('removeFromIndex removes only the given fileId', () => {
  indexFile([doc('c1', 'f1')], 'f1');
  indexFile([doc('c2', 'f2')], 'f2');
  removeFromIndex('f1');
  assert.equal(indexSize(), 1);
});

test('indexedHashes returns hashes for a file', () => {
  indexFile([doc('c1', 'f1', 'abc'), doc('c2', 'f1', 'def')], 'f1');
  const hashes = indexedHashes('f1');
  assert.ok(hashes.has('abc'));
  assert.ok(hashes.has('def'));
});

test('priorVectorsByHash maps hash → vector', () => {
  indexFile([doc('c1', 'f1', 'myhash')], 'f1');
  const prior = priorVectorsByHash('f1');
  assert.deepEqual(prior.get('myhash'), [0.1, 0.2]);
});

test('globalThis pin: fileIndex is shared under soa.files.index', () => {
  indexFile([doc('c1', 'f1')], 'f1');
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.files.index')] as Map<string, unknown>;
  assert.ok(pinned, 'state must be present on globalThis');
  assert.ok(pinned.has('c1'), 'indexed chunk must appear in globalThis state');
});
