/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        files
 * FEATURE:    A file delete is confirmed by the shared store before the user is told it worked
 * USER STORY: As a user who deletes a file I want it to be gone for every process and after every
 *             restart — and if the shared store cannot confirm that, to be told the delete failed
 *             with the file still in place, never "deleted" while it is still being served.
 * ARCHITECTURE: a fake of the OpenSearch REST surface (`fetch` replaced) whose DELETE answer is
 *               scripted, plus the in-memory blob backend; drives the store, the permanent-delete
 *               orchestration (record → search chunks → bytes) and the folder cascade.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore, createFile, attachObject, getFile, deleteFile, moveFile, listFileVersions, type Principal,
} from '@tabs/files/lib/store';
import { deleteFilePermanently } from '@tabs/files/lib/physical-delete';
import { putBlob, getBlob, __resetBlobs } from '@tabs/files/lib/object-store';
import { createFolder, getFolder, __resetStore as resetFolders } from '@core/folders/folder-store';
import { archiveFolder, deleteFolder } from '@core/folders/folder-lifecycle';
import '@tabs/files/lib/folder-adapter';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

type Fake = {
  docs: Map<string, unknown>;
  /** Status the next `_doc` DELETEs answer, per file id (default 200). */
  deleteStatus: Map<string, number>;
  deleteByQuery: string[];
  restore: () => void;
};

function fakeOs(): Fake {
  const orig = globalThis.fetch;
  const f: Fake = { docs: new Map(), deleteStatus: new Map(), deleteByQuery: [], restore: () => { globalThis.fetch = orig; } };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = init?.method ?? 'GET';
    if (path.endsWith('/_count')) return json({ count: f.docs.size });
    if (path.endsWith('/_delete_by_query')) { f.deleteByQuery.push(String(init?.body ?? '')); return json({ deleted: 1 }); }
    const m = path.match(/^\/os-file-records\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') { f.docs.set(id, JSON.parse(String(init?.body ?? '{}'))); return json({ result: 'updated' }); }
      if (method === 'DELETE') {
        const st = f.deleteStatus.get(id) ?? 200;
        if (st >= 200 && st < 300) f.docs.delete(id);
        return json({ result: st === 200 ? 'deleted' : 'error' }, st);
      }
    }
    return json({});
  }) as typeof fetch;
  return f;
}

const settle = () => new Promise((r) => setTimeout(r, 5));
let os: Fake;
beforeEach(() => { os = fakeOs(); __resetStore(); __resetBlobs(); resetFolders(); });
afterEach(() => { os.restore(); });

async function storedFile(name: string, folder?: string) {
  const a = createFile(amir, { name, storage: 'object-store', text: `${name} body`, bytes: 5, folder });
  const object = attachObject(a.id, amir, { contentType: 'application/pdf', bytes: 5 });
  await putBlob(object.key, Buffer.from([1, 2, 3, 4, 5]), 'application/pdf');
  await settle();
  return getFile(a.id, amir);
}

test('a delete the shared store refuses is reported as failed, and NOTHING is removed', async () => {
  const v = await storedFile('Deck.pdf');
  moveFile(v.asset.id, amir, '/kept'); // a version entry that must survive the failed delete
  await settle();
  os.deleteStatus.set(v.asset.id, 503);
  await assert.rejects(deleteFile(v.asset.id, amir), (e: unknown) => (e as { status?: number }).status === 503);
  assert.equal(getFile(v.asset.id, amir).asset.id, v.asset.id, 'the file is still there for the user');
  assert.ok(os.docs.has(v.asset.id), 'and still in the shared store — the two agree');
  assert.ok(listFileVersions(v.asset.id, amir).length >= 1, 'its history is kept');
});

test('the permanent delete removes the record, its search chunks and its bytes, in that order, all confirmed', async () => {
  const v = await storedFile('Deck.pdf');
  const key = v.object!.key;
  const report = await deleteFilePermanently(v.asset.id, amir);
  assert.throws(() => getFile(v.asset.id, amir), /not found/i);
  assert.equal(os.docs.has(v.asset.id), false, 'the shared store confirmed the delete');
  assert.equal(os.deleteByQuery.length, 1, 'the OpenSearch chunks of the file were deleted');
  assert.match(os.deleteByQuery[0], new RegExp(v.asset.id));
  assert.deepEqual(report.index, { ok: true });
  assert.deepEqual(report.physical, [{ target: key, ok: true }]);
  assert.equal(await getBlob(key), null, 'the bytes are gone');
});

test('a failed record delete purges neither chunks nor bytes', async () => {
  const v = await storedFile('Deck.pdf');
  os.deleteStatus.set(v.asset.id, 503);
  await assert.rejects(deleteFilePermanently(v.asset.id, amir), (e: unknown) => (e as { status?: number }).status === 503);
  assert.equal(os.deleteByQuery.length, 0);
  assert.notEqual(await getBlob(v.object!.key), null, 'the bytes of a file that still exists are kept');
});

test('an edit racing the delete cannot put the deleted file back into the shared store', async () => {
  const v = await storedFile('Deck.pdf');
  const pending = deleteFile(v.asset.id, amir);
  moveFile(v.asset.id, amir, '/raced'); // in the window between the check and the store's answer
  await pending;
  await settle();
  assert.equal(os.docs.has(v.asset.id), false, 'no write after the delete resurrected the document');
});

test('folder delete: a member the store cannot delete stops the cascade, and the folder stays', async () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const one = await storedFile('one.pdf', '/a');
  const two = await storedFile('two.pdf', '/a');
  archiveFolder(amir, 'files', f.id);
  await settle();
  os.deleteStatus.set(two.asset.id, 503);
  await assert.rejects(deleteFolder(amir, 'files', f.id), (e: unknown) => (e as { status?: number }).status === 503);
  assert.ok(getFolder(f.id), 'the folder row is kept while a member still exists');
  assert.ok(getFile(two.asset.id, amir), 'the member the store refused is still there');
  void one;
});

test('folder delete purges every member\'s bytes and chunks too', async () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/b' });
  const one = await storedFile('one.pdf', '/b');
  archiveFolder(amir, 'files', f.id);
  await settle();
  await deleteFolder(amir, 'files', f.id);
  assert.equal(getFolder(f.id), undefined);
  assert.equal(os.docs.has(one.asset.id), false);
  assert.equal(await getBlob(one.object!.key), null, 'folder delete no longer leaves the bytes behind');
  assert.equal(os.deleteByQuery.length, 1);
});
