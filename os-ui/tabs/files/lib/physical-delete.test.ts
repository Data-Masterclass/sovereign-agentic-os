/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { objectPurgePlan, purgeFileObjects, type DeleteFn } from '@tabs/files/lib/physical-delete';
import { __resetStore, createFile, attachObject, getFile, deleteFile, archiveFile, type Principal } from '@tabs/files/lib/store';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

beforeEach(() => { __resetStore(); });

// `deleteFile` waits for the shared store (OpenSearch) to confirm: answer like a healthy cluster.
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = (async () => new Response('{"result":"deleted"}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch; });
after(() => { globalThis.fetch = realFetch; });


/** A file WITH stored object bytes (object-store storage + attached object meta). */
function fileWithObject() {
  const a = createFile(amir, { name: 'Deck', storage: 'object-store', text: 'hello', bytes: 5 });
  attachObject(a.id, amir, { contentType: 'application/pdf', bytes: 5 });
  return getFile(a.id, amir);
}

test('objectPurgePlan: a stored file plans its one governed object key', async () => {
  const v = fileWithObject();
  const rec = await deleteFile(v.asset.id, amir); // returns the record so we can plan
  const plan = objectPurgePlan(rec);
  assert.equal(plan.length, 1);
  assert.ok(plan[0].key.startsWith('amir/'), 'key is under the owner prefix (s3://files/<owner>/…)');
  assert.equal(plan[0].key, rec.object!.key);
});

test('objectPurgePlan: a text-only (no-object) file has nothing to purge', async () => {
  const a = createFile(amir, { name: 'Note', storage: 'in-place', text: 'body' });
  const rec = await deleteFile(a.id, amir);
  assert.deepEqual(objectPurgePlan(rec), []);
});

test('purgeFileObjects deletes the right key and reports an honest success', async () => {
  const v = fileWithObject();
  const rec = await deleteFile(v.asset.id, amir);
  const deleted: string[] = [];
  const del: DeleteFn = async (key) => { deleted.push(key); };
  const report = await purgeFileObjects(rec, del);
  assert.equal(report.recordDeleted, true);
  assert.deepEqual(deleted, [rec.object!.key], 'the stored bytes were physically deleted');
  assert.deepEqual(report.physical, [{ target: rec.object!.key, ok: true }]);
});

test('purgeFileObjects is HONEST when the object store is unreachable (orphan flagged, never silent)', async () => {
  const v = fileWithObject();
  const rec = await deleteFile(v.asset.id, amir);
  const report = await purgeFileObjects(rec, async () => { throw new Error('MinIO unreachable'); });
  assert.equal(report.recordDeleted, true);
  assert.equal(report.physical.length, 1);
  assert.equal(report.physical[0].ok, false);
  assert.match(report.physical[0].reason!, /unreachable/);
});

test('ARCHIVE never purges — the object key is retained for restore', async () => {
  const v = fileWithObject();
  const key = v.object!.key;
  archiveFile(v.asset.id, amir);
  // Archive touched no blob backend; the record + its object meta are intact.
  const still = getFile(v.asset.id, amir);
  assert.equal(still.object!.key, key, 'archive keeps the stored object (reversible)');
  assert.equal(still.asset.id, v.asset.id);
});
