/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * End-to-end `filesRetrieve` (the governed `search_files` entry) over the OFFLINE
 * in-process hybrid index — no network. Proves the whole pipeline, not just the
 * pure rerank/DLS units:
 *   • OPA gate first (ungranted subject → deny, zero passages);
 *   • allow path returns NON-EMPTY cited passages (snippet + name + deepLink) an
 *     agent can quote;
 *   • DLS scoping end-to-end — a file the reader is NOT entitled to (another
 *     domain's asset, no named grant) is never returned even though it is indexed.
 *
 * `fetch` is forced unreachable → OPA falls to its local mirror (the `sales` domain
 * is granted `files_retrieve`) and the live OpenSearch search is skipped, so the
 * retriever reads the in-process index we seed with `indexFile`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { filesRetrieve } from './retrieve.ts';
import { indexFile, __resetIndex, type ChunkDoc } from './index-store.ts';
import { mockEmbed } from './embed.ts';

const realFetch = globalThis.fetch;
beforeEach(() => {
  __resetIndex();
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function doc(over: {
  fileId: string; text: string; name?: string;
  owner?: string; tier?: 'dataset' | 'asset' | 'product'; domain?: string; grantedUsers?: string[];
}): ChunkDoc {
  return {
    fileId: over.fileId, chunkId: `${over.fileId}#0`, repType: 'text', text: over.text, hash: over.fileId,
    vector: mockEmbed(over.text),
    meta: {
      owner: over.owner ?? 'sara', tier: over.tier ?? 'asset', domain: over.domain ?? 'sales',
      grantedUsers: over.grantedUsers ?? [], name: over.name ?? over.fileId, deepLink: `/files/${over.fileId}`,
      kind: 'doc', tags: [], freshness: null,
    },
  };
}

test('OPA gate: an ungranted subject is denied (no passages)', async () => {
  indexFile([doc({ fileId: 'f1', text: 'quarterly refund summary' })], 'f1');
  const res = await filesRetrieve({
    principal: { id: 'x', domains: ['marketing'] },
    grantSubject: 'marketing', // not in the local grant mirror → deny
    query: 'refund',
  });
  assert.equal(res.decision, 'deny');
  assert.equal(res.passages.length, 0);
});

test('allow path returns non-empty cited passages (snippet + name + deepLink)', async () => {
  indexFile([doc({ fileId: 'f1', text: 'the quarterly refund summary for late orders', name: 'Refunds Q1' })], 'f1');
  const res = await filesRetrieve({
    principal: { id: 'sara', domains: ['sales'] },
    query: 'refund summary late orders',
  });
  assert.equal(res.decision, 'allow');
  assert.ok(res.passages.length > 0, 'non-empty');
  const top = res.passages.find((p) => p.fileId === 'f1');
  assert.ok(top, 'the granted file is retrieved');
  assert.ok(top!.snippet.length > 0, 'a citable snippet is returned');
  assert.equal(top!.name, 'Refunds Q1');
  assert.equal(top!.deepLink, '/files/f1');
});

test('DLS: a file in another domain with no named grant is never returned', async () => {
  indexFile([doc({ fileId: 'mine', text: 'sales refund guidance', domain: 'sales', tier: 'asset' })], 'mine');
  // Another domain's asset, reader not named → must stay hidden. (indexFile scopes
  // by fileId, so each file is added under its own scope.)
  indexFile([doc({ fileId: 'secret', text: 'finance refund secret', domain: 'finance', tier: 'asset', owner: 'fred' })], 'secret');

  const res = await filesRetrieve({ principal: { id: 'sara', domains: ['sales'] }, query: 'refund' });
  assert.equal(res.decision, 'allow');
  const ids = res.passages.map((p) => p.fileId);
  assert.ok(ids.includes('mine'), 'sees own-domain asset');
  assert.ok(!ids.includes('secret'), 'NEVER leaks the cross-domain file');
});
