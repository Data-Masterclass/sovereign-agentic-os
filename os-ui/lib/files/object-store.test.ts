/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { putBlob, getBlob, setBlobBackend, memoryBackend, __resetBlobs, type BlobBackend } from './object-store.ts';
import { __resetStore, createFile, attachObject, getFile, objectKeyForAsset, type Principal } from './store.ts';
import { AssetError } from './asset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const outsider: Principal = { id: 'zoe', domains: ['ops'], role: 'creator' };

beforeEach(() => { __resetStore(); __resetBlobs(); });

// ---- the blob store: round-trip, isolation, pluggability ----

test('putBlob → getBlob returns the SAME bytes byte-for-byte', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]); // PNG-ish binary
  await putBlob('sales/amir/pic.png', bytes, 'image/png');
  const got = await getBlob('sales/amir/pic.png');
  assert.ok(got);
  assert.equal(got!.contentType, 'image/png');
  assert.deepEqual([...got!.body], [...bytes]);
});

test('getBlob returns null for an absent key', async () => {
  assert.equal(await getBlob('nope/missing'), null);
});

test('memoryBackend copies the buffer so later mutation cannot corrupt the store', async () => {
  const bytes = Buffer.from([1, 2, 3]);
  await putBlob('k', bytes, 'application/octet-stream');
  bytes[0] = 99; // mutate the caller's buffer after the put
  const got = await getBlob('k');
  assert.deepEqual([...got!.body], [1, 2, 3]);
});

test('setBlobBackend swaps the durable backend (server registration path)', async () => {
  const calls: string[] = [];
  const fake: BlobBackend = {
    async put(key) { calls.push(`put:${key}`); },
    async get(key) { calls.push(`get:${key}`); return null; },
  };
  setBlobBackend(fake);
  await putBlob('x', Buffer.from('y'), 'text/plain');
  await getBlob('x');
  assert.deepEqual(calls, ['put:x', 'get:x']);
  setBlobBackend(memoryBackend); // restore
});

// ---- the upload→download contract at the store layer ----

test('UI upload stores the original under the OWNER prefix and it round-trips on download', async () => {
  // 1) createFile (private → owner prefix), 2) PUT bytes at its key, 3) attachObject.
  const bytes = Buffer.from('%PDF-1.7 binary-ish body \x00\x01', 'binary');
  const asset = createFile(amir, { name: 'contract.pdf', folder: '/deals', tags: ['x'] });
  const key = objectKeyForAsset(asset);
  assert.equal(key, 'amir/deals/contract.pdf'); // owner prefix, folder, name
  await putBlob(key!, bytes, 'application/pdf');
  attachObject(asset.id, amir, { contentType: 'application/pdf', bytes: bytes.length });

  // Download path: getFile (canView gate) → getBlob(view.object.key) → same bytes.
  const view = getFile(asset.id, amir);
  assert.ok(view.object, 'object metadata recorded');
  assert.equal(view.object!.contentType, 'application/pdf');
  const blob = await getBlob(view.object!.key);
  assert.ok(blob);
  assert.deepEqual([...blob!.body], [...bytes]);
});

test('canView gate: a non-viewer cannot getFile (the download route 403s the same way)', () => {
  const asset = createFile(amir, { name: 'private.pdf', folder: '/' });
  attachObject(asset.id, amir, { contentType: 'application/pdf', bytes: 3 });
  assert.throws(() => getFile(asset.id, outsider), (e) => e instanceof AssetError && (e as AssetError).status === 403);
});

test('attachObject requires edit permission (non-owner is denied)', () => {
  const asset = createFile(amir, { name: 'p.pdf', folder: '/' });
  assert.throws(
    () => attachObject(asset.id, outsider, { contentType: 'application/pdf', bytes: 1 }),
    (e) => e instanceof AssetError && ((e as AssetError).status === 403 || (e as AssetError).status === 404),
  );
});

test('text-only (MCP) record has no object but downloads its text — never empty', () => {
  const asset = createFile(amir, { name: 'memo.pdf', folder: '/', text: 'The extracted memo body.' });
  const view = getFile(asset.id, amir);
  assert.equal(view.object, null, 'no original object for a text-only upload');
  assert.ok(view.text.length > 0, 'text is served instead of an empty body');
  assert.equal(view.text, 'The extracted memo body.');
});

test('objectKeyForAsset is null for in-place references (nothing of ours to serve)', () => {
  const asset = createFile(amir, { name: 'linked.csv', folder: '/', storage: 'in-place', sourceUri: 'https://drive/x' });
  assert.equal(objectKeyForAsset(asset), null);
});
