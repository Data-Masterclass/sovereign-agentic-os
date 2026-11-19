/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       files
 * FEATURE:    The "Searchable" chip means the index really took the file
 * USER STORY: As a file owner I want a file to read "Searchable" only once its index rows were
 *             really written, and "Indexing failed" or "Not indexed" otherwise, so I never rely
 *             on search, or hand a file to an agent, on the strength of a chip that only knew
 *             the file was ALLOWED to be indexed.
 * ARCHITECTURE:
 *   - The outcome of the last index run is recorded on the file's own `asset.yaml`
 *     (`indexing.outcome`), by `indexAsset` itself, so every door — upload, edit, connector
 *     sync, extraction, the boot sweep, the admin re-index — records it through one place.
 *   - The chip (`fileStatusOf`) reads that outcome; the indexing MODE alone no longer decides it.
 *   - The real pipeline runs. Only `fetch` is stubbed (so the embeddings gateway is unreachable)
 *     and the offline-mock switch is set, exactly as a deployed cluster would have them.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createFile, listFiles, getFile, type Principal } from '@tabs/files/lib/store';
import { indexAsset } from '@tabs/files/lib/index-pipeline';
import { __resetIndex } from '@tabs/files/lib/index-store';
import { parseAsset, serializeAsset } from '@tabs/files/lib/asset-schema';
import { OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const realFetch = globalThis.fetch;

async function withEnv(flag: string, body: () => Promise<void>): Promise<void> {
  const prev = process.env[OFFLINE_MOCK_ENV];
  process.env[OFFLINE_MOCK_ENV] = flag;
  globalThis.fetch = (() => Promise.reject(new Error('gateway unreachable'))) as typeof fetch;
  try { await body(); } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prev;
  }
}

const statusOf = (id: string) => listFiles(amir).mine.find((f) => f.id === id)?.status;

beforeEach(() => { __resetStore(); __resetIndex(); });

test('an indexable file that has not been through the index yet is NOT reported searchable', () => {
  const a = createFile(amir, { name: 'memo.md', sensitivity: 'internal', text: 'quarterly memo body' });
  assert.equal(a.indexing.mode, 'indexed', 'the file is allowed to be indexed');
  assert.equal(statusOf(a.id), 'not-indexed');
});

test('when the embeddings gateway is down the file reads "index-failed", not "searchable"', async () => {
  const a = createFile(amir, { name: 'memo.md', sensitivity: 'internal', text: 'quarterly memo body' });
  await withEnv('refuse', async () => {
    await assert.rejects(() => indexAsset(a, 'quarterly memo body'));
  });
  assert.equal(statusOf(a.id), 'index-failed');
  const outcome = getFile(a.id, amir).asset.indexing.outcome;
  assert.equal(outcome?.status, 'failed');
  assert.ok(outcome?.reason, 'the failure carries its reason');
});

test('a run that really wrote the index rows makes the file searchable', async () => {
  const a = createFile(amir, { name: 'memo.md', sensitivity: 'internal', text: 'quarterly memo body' });
  const report = await indexAsset(a, 'quarterly memo body', {
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0, 0]), model: 'm', dim: 3, mode: 'live' as const }),
  });
  assert.equal(report.status, 'searchable');
  assert.equal(statusOf(a.id), 'searchable');
  assert.equal(getFile(a.id, amir).asset.indexing.outcome?.chunks, report.indexed);
});

test('a later failure replaces an earlier success: the chip follows the LAST run', async () => {
  const a = createFile(amir, { name: 'memo.md', sensitivity: 'internal', text: 'v1 body' });
  await indexAsset(a, 'v1 body', {
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0, 0]), model: 'm', dim: 3, mode: 'live' as const }),
  });
  assert.equal(statusOf(a.id), 'searchable');
  await assert.rejects(() => indexAsset(a, 'v2 body', { embed: async () => { throw new Error('gateway 502'); } }));
  assert.equal(statusOf(a.id), 'index-failed');
});

test('the outcome survives the asset.yaml round trip (it is durable, not process memory)', () => {
  const a = createFile(amir, { name: 'memo.md', text: 'x' });
  a.indexing.outcome = { status: 'failed', at: '2026-11-19T10:00:00.000Z', reason: 'gateway 502' };
  const back = parseAsset(serializeAsset(a));
  assert.deepEqual(back.indexing.outcome, { status: 'failed', at: '2026-11-19T10:00:00.000Z', reason: 'gateway 502' });
});
