/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        files
 * FEATURE:    A file upload is stored in object storage, or it fails — never "saved" into memory only
 * USER STORY: As a user who uploads a file I want it to still be there after os-ui restarts. If object storage
 *             cannot take it, I want "upload failed, try again" — not a success that silently vanishes later,
 *             and no file entry pointing at bytes that were never stored.
 * ARCHITECTURE: drives the pure blob store (`object-store.ts`), the S3 backend factory
 *             (`object-store-server.ts`, with injected object-store calls), and the new-file helper
 *             (`blob-writes.ts`) against a failing backend; the in-memory store stays only as the explicit
 *             `FILES_BLOB_STORE=memory` mode.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  putBlob, getBlob, setBlobBackend, memoryBackend, blobStoreMode, __resetBlobs, type BlobBackend,
} from '@tabs/files/lib/object-store';
import { makeS3BlobBackend, resolveBlobStoreMode } from '@tabs/files/lib/object-store-server';
import { storeNewFileBytes, replaceFileBytes } from '@tabs/files/lib/blob-writes';
import { __resetStore, createFile, getFile, listFiles, addVersion, type Principal } from '@tabs/files/lib/store';
import { errorBodyOf } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const zoe: Principal = { id: 'zoe', domains: ['sales'], role: 'creator' };

const failing = (what = 'connect ECONNREFUSED 10.0.0.1:9000'): BlobBackend => ({
  async put() { throw new Error(what); },
  async get() { throw new Error(what); },
  async del() { throw new Error(what); },
});

// Silence the server-side cause log the store writes on failure (asserted where it matters).
let errors: string[] = [];
const origError = console.error;
beforeEach(() => {
  __resetStore(); __resetBlobs(); errors = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
});
afterEach(() => { console.error = origError; });

// ---- the blob store surface: typed errors, no swallowing ----

test('a failed object-storage write throws a typed, coded 503 — the caller cannot mistake it for success', async () => {
  setBlobBackend(failing());
  await assert.rejects(putBlob('amir/a.pdf', Buffer.from('x'), 'application/pdf'), (e: Error & { status?: number }) => {
    assert.equal(e.status, 503);
    const body = errorBodyOf(e);
    assert.equal(body.code, 'files.storageWriteFailed');
    assert.ok(!/ECONNREFUSED|10\.0\.0\.1/.test(body.error), 'the internal cause is logged, not sent to the person');
    assertServerEnglish(body); // English matches the catalog, and all 7 locales have it
    return true;
  });
  assert.ok(errors.some((l) => /ECONNREFUSED/.test(l)), 'the cause is in the server log');
});

test('a failed object-storage read throws a typed, coded 503 — never a stale copy', async () => {
  setBlobBackend(failing('object-store GET 500: InternalError'));
  await assert.rejects(getBlob('amir/a.pdf'), (e: Error & { status?: number }) => {
    assert.equal(e.status, 503);
    const body = errorBodyOf(e);
    assert.equal(body.code, 'files.storageReadFailed');
    assertServerEnglish(body);
    return true;
  });
});

test('the store reports which mode it runs in: memory only when configured, object storage otherwise', () => {
  assert.equal(blobStoreMode(), 'memory'); // the pure default (unit tests, nothing registered)
  setBlobBackend(failing());
  assert.equal(blobStoreMode(), 'object-storage');
  setBlobBackend(memoryBackend, 'memory');
  assert.equal(blobStoreMode(), 'memory');
});

// ---- the server backend: object storage only, no in-memory shadow copy ----

test('resolveBlobStoreMode: memory ONLY when FILES_BLOB_STORE=memory; missing credentials are not a memory mode', () => {
  assert.equal(resolveBlobStoreMode({ filesBlobStore: 'memory', awsAccessKeyId: '', awsSecretAccessKey: '' }), 'memory');
  assert.equal(resolveBlobStoreMode({ filesBlobStore: 'memory', awsAccessKeyId: 'k', awsSecretAccessKey: 's' }), 'memory');
  assert.equal(resolveBlobStoreMode({ filesBlobStore: '', awsAccessKeyId: 'k', awsSecretAccessKey: 's' }), 'object-storage');
  // No credentials and no explicit memory mode → object storage (whose writes then fail loudly), never memory.
  assert.equal(resolveBlobStoreMode({ filesBlobStore: '', awsAccessKeyId: '', awsSecretAccessKey: '' }), 'object-storage');
});

test('S3 backend: a failed PUT throws and leaves NO in-memory copy to be served later', async () => {
  const be = makeS3BlobBackend({
    putObject: async () => { throw new Error('object-store PUT 503: SlowDown'); },
    getObject: async () => null,
    deleteObject: async () => {},
  });
  setBlobBackend(be);
  await assert.rejects(putBlob('amir/report.pdf', Buffer.from('%PDF'), 'application/pdf'), /could not be saved/);
  // Before the fix the bytes were parked in memory and served as if persisted.
  assert.equal(await memoryBackend.get('amir/report.pdf'), null, 'nothing was parked in memory');
  assert.equal(await getBlob('amir/report.pdf'), null, 'the object is honestly absent');
});

test('S3 backend: a failed GET throws — it does not fall back to an in-memory copy', async () => {
  await memoryBackend.put('amir/old.pdf', Buffer.from('stale'), 'application/pdf'); // a stale process copy
  setBlobBackend(makeS3BlobBackend({
    putObject: async () => {},
    getObject: async () => { throw new Error('object-store GET 500'); },
    deleteObject: async () => {},
  }));
  await assert.rejects(getBlob('amir/old.pdf'), /could not be read/);
});

test('S3 backend: a successful PUT goes to object storage only, and GET reads it from there', async () => {
  const bucket = new Map<string, { body: Buffer; contentType: string }>();
  setBlobBackend(makeS3BlobBackend({
    putObject: async (k, b, ct) => { bucket.set(k, { body: Buffer.from(b), contentType: ct }); },
    getObject: async (k) => bucket.get(k) ?? null,
    deleteObject: async (k) => { bucket.delete(k); },
  }));
  await putBlob('amir/x.txt', Buffer.from('hello'), 'text/plain');
  assert.equal(bucket.get('amir/x.txt')?.body.toString(), 'hello');
  assert.equal(await memoryBackend.get('amir/x.txt'), null, 'no shadow copy in memory');
  assert.equal((await getBlob('amir/x.txt'))?.body.toString(), 'hello');
});

test('explicit memory mode still round-trips (laptop / tests)', async () => {
  setBlobBackend(memoryBackend, 'memory');
  await putBlob('amir/note.txt', Buffer.from('hi'), 'text/plain');
  assert.equal((await getBlob('amir/note.txt'))?.body.toString(), 'hi');
});

// ---- callers: a failed write records nothing ----

test('new file: a failed write removes the just-created record — no entry points at a missing object', async () => {
  setBlobBackend(failing());
  const asset = createFile(amir, { name: 'contract.pdf', folder: '/deals', bytes: 4 });
  await assert.rejects(storeNewFileBytes(asset, amir, Buffer.from('%PDF'), 'application/pdf'), (e: Error) => {
    assert.equal(errorBodyOf(e).code, 'files.storageWriteFailed');
    return true;
  });
  assert.throws(() => getFile(asset.id, amir), /not found/i, 'the record is gone');
  const all = Object.values(listFiles(amir)).flat() as { id?: string }[];
  assert.ok(!all.some((s) => s && s.id === asset.id), 'not listed');
});

test('new file: a successful write records the object metadata', async () => {
  setBlobBackend(memoryBackend, 'memory');
  const asset = createFile(amir, { name: 'ok.pdf', bytes: 4 });
  await storeNewFileBytes(asset, amir, Buffer.from('%PDF'), 'application/pdf');
  const view = getFile(asset.id, amir);
  assert.ok(view.object);
  assert.equal(view.object!.contentType, 'application/pdf');
  assert.equal((await getBlob(view.object!.key))?.body.toString(), '%PDF');
});

test('new version: the bytes are written BEFORE the version is recorded — a failed write changes nothing', async () => {
  setBlobBackend(memoryBackend, 'memory');
  const asset = createFile(amir, { name: 'notes.md', text: 'v1 text', bytes: 7 });
  await storeNewFileBytes(asset, amir, Buffer.from('v1 text'), 'text/markdown');
  setBlobBackend(failing());
  await assert.rejects(replaceFileBytes(asset.id, amir, Buffer.from('v2 text'), 'text/markdown'), /could not be saved/);
  const view = getFile(asset.id, amir);
  assert.equal(view.asset.version, 'v1', 'no version was recorded');
  assert.equal(view.text, 'v1 text');
  setBlobBackend(memoryBackend, 'memory');
  assert.equal((await getBlob(view.object!.key))?.body.toString(), 'v1 text', 'the stored bytes are the old, consistent ones');
});

test('new version: only someone who may edit the file can overwrite its bytes', async () => {
  setBlobBackend(memoryBackend, 'memory');
  const asset = createFile(amir, { name: 'mine.txt', text: 'mine', bytes: 4 });
  await storeNewFileBytes(asset, amir, Buffer.from('mine'), 'text/plain');
  await assert.rejects(replaceFileBytes(asset.id, zoe, Buffer.from('hacked'), 'text/plain'));
  const view = getFile(asset.id, amir);
  assert.equal((await getBlob(view.object!.key))?.body.toString(), 'mine');
  addVersion(asset.id, amir, { text: 'still mine' }); // the owner can still edit
});
