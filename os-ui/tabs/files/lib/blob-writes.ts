/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Write a file's original bytes so the record never claims bytes that were not stored
 * USER STORY: As a user I want an upload that object storage refused to fail ("try again"), with no file
 *             entry left behind pointing at nothing — and a new version that could not be stored to leave
 *             the file exactly as it was.
 * ARCHITECTURE:
 *   - `storeNewFileBytes`: after `createFile`, PUT the bytes; only a confirmed write is recorded
 *     (`attachObject`). A failed write discards the just-created record (`discardUnstoredFile`) and
 *     rethrows the typed `files.storageWriteFailed`.
 *   - `replaceFileBytes`: edit-gated FIRST, then the PUT, and only then the caller records the version —
 *     the object key does not change between versions, so a failed PUT leaves the old bytes and the old
 *     version consistent.
 *   - Pure (no `server-only`): the server registers the durable backend (object-store-server.ts).
 */
import { putBlob } from '@tabs/files/lib/object-store';
import {
  attachObject, discardUnstoredFile, objectKeyForAsset, editableFile, type Principal,
} from '@tabs/files/lib/store';
import type { FileAsset } from '@tabs/files/lib/asset-schema';

/** Store a NEW file's original bytes and record them. On a failed write the record is removed and the
 *  typed storage error is rethrown. A file with no object-store location (in-place) stores nothing. */
export async function storeNewFileBytes(asset: FileAsset, user: Principal, bytes: Buffer, contentType: string): Promise<void> {
  const key = objectKeyForAsset(asset);
  if (!key) return;
  try {
    await putBlob(key, bytes, contentType);
  } catch (e) {
    await discardUnstoredFile(asset.id);
    throw e;
  }
  attachObject(asset.id, user, { contentType, bytes: bytes.length });
}

/** Overwrite an EXISTING file's original bytes (a new version). Edit-gated before anything is written.
 *  Returns the key written, or null when the file has no object-store location. Records nothing: the
 *  caller adds the version and `attachObject`s only after this resolved. */
export async function replaceFileBytes(id: string, user: Principal, bytes: Buffer, contentType: string): Promise<string | null> {
  const asset = editableFile(id, user); // owner / in-domain admin — or it throws, before any write
  const key = objectKeyForAsset(asset);
  if (!key) return null;
  await putBlob(key, bytes, contentType);
  return key;
}
