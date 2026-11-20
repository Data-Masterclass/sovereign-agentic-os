/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connected drive sources survive an os-ui restart
 * USER STORY: As a user who connected my OneDrive as a Files source I want it, its delta cursor
 *             and its import ledger still there after a deploy, so the next sync is incremental
 *             and never imports a file twice.
 * ARCHITECTURE:
 *   - The REAL connectors store over the shared fake OpenSearch (`core/infra/two-process-fixture.ts`,
 *     the same fixture the other stores' restart tests use). A restart is an empty process that
 *     hydrates. The twins prove a partial or failed read is never taken as the store's contents.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';

process.env.OS_OFFLINE_MOCK = 'allow'; // the mock drive client stands in for Graph here

const c = await import('@tabs/files/lib/connectors');
const KEYS = [Symbol.for('soa.files.connectors.state')];
const INDEX = 'os-files-sources';
const owner = 'aborek';

beforeEach(() => c.__resetConnectors());

async function webWithOneSyncedSource() {
  const os = fakeCluster();
  const web = proc();
  const src = await as(web, KEYS, async () => {
    await c.ensureSourcesHydrated();
    const s = c.addSource({ provider: 'onedrive', label: 'My OneDrive', scope: 'drive', target: 'root', mode: 'copy', owner, domain: 'sales', connectionId: 'conn_od1' });
    await c.runSync(s, c.mockClient('onedrive'), { upsert: (file, src) => { (src.imported ??= {})[file.remoteId] = { fileId: `f-${file.remoteId}`, hash: file.contentHash }; return 'added'; } });
    return s;
  });
  return { os, src };
}

test('a restarted process hydrates the source with its link, cursor and import ledger', async () => {
  const { os, src } = await webWithOneSyncedSource();
  try {
    assert.ok(os.doc(INDEX, src.id), 'the source was written through to the mirror');
    const after = await as(proc(), KEYS, async () => { await c.ensureSourcesHydrated(); return { state: c.sourcesHydrationState(), s: c.getSource(src.id), list: c.listSources(owner) }; });
    assert.equal(after.state, 'hydrated');
    assert.ok(after.s, 'the source is back after the restart');
    assert.equal(after.s!.connectionId, 'conn_od1');
    assert.equal(after.s!.initialDone, true);
    assert.equal(after.s!.cursor, src.cursor);
    assert.deepEqual(Object.keys(after.s!.imported ?? {}).sort(), Object.keys(src.imported ?? {}).sort());
    assert.ok(Object.keys(after.s!.imported ?? {}).length > 0, 'the ledger is not empty');
    assert.equal(after.list.length, 1);
  } finally { os.restore(); }
});

test('a removed source stays removed after a restart', async () => {
  const { os, src } = await webWithOneSyncedSource();
  try {
    await as(proc(), KEYS, async () => { await c.ensureSourcesHydrated(); assert.equal(c.removeSource(src.id, owner), true); });
    assert.equal(os.doc(INDEX, src.id), undefined);
    const s = await as(proc(), KEYS, async () => { await c.ensureSourcesHydrated(); return c.getSource(src.id); });
    assert.equal(s, null);
  } finally { os.restore(); }
});

test('twin: a TRUNCATED read is not the store — un-hydrated ("failed"), retried, then complete', async () => {
  const { os, src } = await webWithOneSyncedSource();
  try {
    os.mode = 'truncated';
    const fresh = proc();
    const first = await as(fresh, KEYS, async () => { await c.ensureSourcesHydrated(); return c.sourcesHydrationState(); });
    assert.equal(first, 'failed', 'a partial read is never cached as done');
    os.mode = 'ok';
    const second = await as(fresh, KEYS, async () => { await c.ensureSourcesHydrated(); return { state: c.sourcesHydrationState(), s: c.getSource(src.id) }; });
    assert.equal(second.state, 'hydrated', 'the next call retried');
    assert.ok(second.s);
  } finally { os.restore(); }
});

test('twin: an unreachable mirror leaves the store un-hydrated, never "hydrated and empty"', async () => {
  const { os } = await webWithOneSyncedSource();
  try {
    os.mode = 'down';
    const state = await as(proc(), KEYS, async () => { await c.ensureSourcesHydrated(); return c.sourcesHydrationState(); });
    assert.equal(state, 'failed');
  } finally { os.restore(); }
});
