/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Drive-source syncs re-check their owner on every run, refuse on an unloaded store,
 *             and never import a remote item twice
 * USER STORY: As an admin I want a connected drive to stop syncing the moment its owner is
 *             deactivated, leaves the domain or loses the drive connection; as a user I want a
 *             failed store load or an interrupted sync never to double my files.
 * ARCHITECTURE:
 *   - The real `runConnectorSync` / `indexDriveSource` / store sink over a fresh fake OpenSearch
 *     (`two-process-fixture`, the stores' restart fixture) and the teaching-flow mock drive. The
 *     owner's live principal and the drive grant are the `SyncEntitlement` ports the routes wire
 *     (`principalById`, `resolveConnectionAccessToken`).
 *   - Each refusal has its twin: an entitled owner syncs and lifts a pause; a loaded store adds
 *     and finds the existing source; a taken import id is refused (409), never duplicated.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';

process.env.OS_OFFLINE_MOCK = 'allow'; // the mock drive stands in for Graph; the guards are what is tested

const c = await import('@tabs/files/lib/connectors');
const srv = await import('@tabs/files/lib/connectors-server');
const files = await import('@tabs/files/lib/store');

const owner = { id: 'aborek', domains: ['sales'], role: 'creator' as const };
let cluster: ReturnType<typeof fakeCluster>;
beforeEach(() => { cluster = fakeCluster(); c.__resetConnectors(); files.__resetStore(); });
afterEach(() => cluster.restore());

const entitled = { liveOwner: async () => ({ domains: ['sales'] }), token: async () => null };
async function newSource() {
  await c.requireSourcesLoaded();
  return c.addSource({ provider: 'onedrive', label: 'OD', scope: 'drive', target: 'root', mode: 'copy', owner: owner.id, domain: 'sales', connectionId: 'conn_od1' });
}
const status = (code: string, st: number) => (e: Error & { code?: string; status?: number }) => e.code === code && e.status === st;
const odFiles = () => files.listFiles(owner).mine.filter((f) => f.name === 'budget.xlsx' || f.name === 'notes.docx' || f.name.endsWith('.pdf'));

// ---------------------------------------------------------------- 1. live owner checks --

test('an entitled owner syncs', async () => {
  const s = await newSource();
  const r = await srv.runConnectorSync(s.id, owner.id, entitled);
  assert.ok(r.added > 0);
  assert.equal(c.getSource(s.id)!.paused ?? null, null);
});

test('twin: a DEACTIVATED owner — the run stops, the source is paused (durably), nothing is read', async () => {
  const s = await newSource();
  let tokenRead = false;
  await assert.rejects(srv.runConnectorSync(s.id, owner.id, { liveOwner: async () => null, token: async () => { tokenRead = true; return null; } }), status('source_paused', 403));
  assert.equal(tokenRead, false, 'the drive token is never even resolved');
  assert.match(c.getSource(s.id)!.paused!.reason, /deactivated/);
  assert.match(JSON.stringify(cluster.doc('os-files-sources', s.id)), /deactivated/, 'the pause is persisted');
  assert.equal(odFiles().length, 0);
});

test('twin: an owner who LEFT the source\'s domain — paused', async () => {
  const s = await newSource();
  await assert.rejects(srv.runConnectorSync(s.id, owner.id, { liveOwner: async () => ({ domains: ['finance'] }), token: async () => null }), status('source_paused', 403));
  assert.match(c.getSource(s.id)!.paused!.reason, /no longer a member of sales/);
});

test('twin: an owner who LOST the drive grant (connection gone: 404) — paused', async () => {
  const s = await newSource();
  const gone = async () => { throw Object.assign(new Error('Connection not found'), { status: 404 }); };
  await assert.rejects(srv.runConnectorSync(s.id, owner.id, { liveOwner: entitled.liveOwner, token: gone }), status('source_paused', 403));
  assert.match(c.getSource(s.id)!.paused!.reason, /no longer holds the drive connection/);
});

test('a paused source syncs again once its owner is entitled again (the pause is lifted)', async () => {
  const s = await newSource();
  await assert.rejects(srv.runConnectorSync(s.id, owner.id, { ...entitled, liveOwner: async () => null }));
  await srv.runConnectorSync(s.id, owner.id, entitled);
  assert.equal(c.getSource(s.id)!.paused, null);
});

// ---------------------------------------------------------- 2. store-not-loaded refusal --

test('twin: while loading FAILED, add / sync / remove refuse with the typed store_not_loaded error', async () => {
  const s = await newSource(); // a source exists in the mirror
  cluster.mode = 'down';
  await as(proc(), [Symbol.for('soa.files.connectors.state')], async () => {
    await assert.rejects(c.requireSourcesLoaded(), status('store_not_loaded', 503));
    assert.throws(() => c.addSource({ provider: 'onedrive', label: 'again', scope: 'drive', target: 'root', mode: 'copy', owner: owner.id, domain: 'sales', connectionId: 'conn_od1' }), status('store_not_loaded', 503));
    await assert.rejects(srv.runConnectorSync(s.id, owner.id, entitled), status('store_not_loaded', 503));
    await assert.rejects(srv.indexDriveSource({ connectionId: 'conn_od1', provider: 'onedrive', label: 'OD', owner: owner.id, domain: 'sales', token: 't' }, entitled), status('store_not_loaded', 503));
    assert.throws(() => c.removeSource(s.id, owner.id), status('store_not_loaded', 503));
  });
});

test('once the store loads, the same process adds and syncs (no re-add of the existing source)', async () => {
  const s = await newSource();
  await as(proc(), [Symbol.for('soa.files.connectors.state')], async () => {
    await c.requireSourcesLoaded();
    assert.deepEqual(c.listSources(owner.id).map((x) => x.id), [s.id], 'the existing source is found, not re-added');
  });
});

// --------------------------------------------------------------- 3. idempotent imports --

test('an interrupted sync (files created, ledger lost) re-run imports nothing twice', async () => {
  const s = await newSource();
  await srv.runConnectorSync(s.id, owner.id, entitled);
  const before = odFiles().map((f) => f.id).sort();
  assert.ok(before.length > 0);
  // The crash: the process died after creating the files but before their ledger was written.
  const src = c.getSource(s.id)!;
  src.imported = {}; src.cursor = null; src.initialDone = false;
  await srv.runConnectorSync(s.id, owner.id, entitled);
  assert.deepEqual(odFiles().map((f) => f.id).sort(), before, 'the same files — found by their deterministic id');
});

test('the file id is a function of the source and the Graph item id only', () => {
  assert.equal(srv.importedFileId('src_a', '01ABC'), srv.importedFileId('src_a', '01ABC'));
  assert.notEqual(srv.importedFileId('src_a', '01ABC'), srv.importedFileId('src_b', '01ABC'));
  assert.notEqual(srv.importedFileId('src_a', '01ABC'), srv.importedFileId('src_a', '01ABD'));
});

test('twin: createFile refuses a taken deterministic id (409) — it can never silently overwrite or duplicate', async () => {
  const id = srv.importedFileId('src_x', 'item1');
  files.createFile(owner, { id, name: 'a.txt', text: 'a' });
  assert.throws(() => files.createFile(owner, { id, name: 'a.txt', text: 'a' }), (e: Error & { status?: number }) => e.status === 409);
});
