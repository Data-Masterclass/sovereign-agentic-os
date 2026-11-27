/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Files-tab BLOB store — the original bytes behind an uploaded file (the record
 * in `store.ts` keeps the asset.yaml + extracted text; THIS keeps the raw object so
 * `Download` returns the file byte-for-byte, not a text preview).
 *
 * It is a thin, PURE abstraction over a pluggable backend so it stays unit-testable
 * with no `server-only` / MinIO dependency:
 *   • default backend = an in-process Map (used by unit tests, and by the server ONLY in
 *     the explicit `FILES_BLOB_STORE=memory` mode — laptop / demo — which is logged at
 *     startup and reported on /api/health and /api/status).
 *   • the server registers a MinIO-backed backend (object-store-server.ts) that reuses
 *     the SAME SigV4 client the Data path uses. There is NO memory fallback: a write or
 *     read object storage did not confirm fails here with a typed, coded error
 *     (`files.storageWriteFailed` / `files.storageReadFailed`), so an upload is never
 *     reported as saved while its bytes live only in this process.
 *
 * Keys are the object key WITHIN the governed `files` bucket, i.e. the store's prefix
 * invariant minus `s3://files/` — `<owner|domain>/<folder>/<name>`. The bucket itself
 * is the backend's concern.
 */

import { codedError, serverMessageOf } from '@core/kernel/server-message';

export type Blob = { body: Buffer; contentType: string };

/** Where the bytes live: durable object storage, or (explicitly configured) this process only. */
export type BlobStoreMode = 'object-storage' | 'memory';

export interface BlobBackend {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  /** Physically remove the object at `key` (idempotent: a missing key is a no-op).
   *  Throws only on a real failure so a DELETE can be reported honestly. */
  del(key: string): Promise<void>;
}

/** The always-available in-process backend (global-symbol-backed so it survives
 *  module reloads within one process, like the file registry itself). */
const MEM_KEY = Symbol.for('soa.files.blobs');
function mem(): Map<string, Blob> {
  const g = globalThis as unknown as Record<symbol, Map<string, Blob> | undefined>;
  if (!g[MEM_KEY]) g[MEM_KEY] = new Map();
  return g[MEM_KEY]!;
}

export const memoryBackend: BlobBackend = {
  async put(key, body, contentType) {
    // Copy the buffer so a later mutation of the caller's buffer can't corrupt it.
    mem().set(key, { body: Buffer.from(body), contentType });
  },
  async get(key) {
    const b = mem().get(key);
    return b ? { body: Buffer.from(b.body), contentType: b.contentType } : null;
  },
  async del(key) {
    mem().delete(key);
  },
};

let backend: BlobBackend = memoryBackend;
let mode: BlobStoreMode = 'memory';

/** Install a backend (called by the server module). Anything but the explicit memory mode is durable storage. */
export function setBlobBackend(b: BlobBackend, m: BlobStoreMode = 'object-storage'): void {
  backend = b;
  mode = m;
}

/** Which mode the blob store runs in (health / status report it). */
export function blobStoreMode(): BlobStoreMode {
  return mode;
}

/** A storage failure, as the person reads it: the English never carries the internal cause (an endpoint,
 *  a bucket, a driver message) — that goes to the server log. An already-coded error passes through. */
function storageError(e: unknown, op: 'write' | 'read', key: string): Error {
  if (serverMessageOf(e).code) return e as Error;
  console.error(`[files] object storage ${op} failed for ${key}: ${(e as Error)?.message ?? String(e)}`);
  return op === 'write'
    ? codedError(503, 'The file could not be saved to storage, so nothing was stored. Please try again.', 'files.storageWriteFailed')
    : codedError(503, 'The file could not be read from storage right now. Please try again.', 'files.storageReadFailed');
}

/** PUT the original bytes for a file at `key`. Resolves only once the backend confirmed the write;
 *  otherwise rejects with `files.storageWriteFailed` (503). */
export async function putBlob(key: string, body: Buffer, contentType: string): Promise<void> {
  try {
    await backend.put(key, body, contentType);
  } catch (e) {
    throw storageError(e, 'write', key);
  }
}

/** GET the original bytes for a file at `key` (or `null` when absent). A read the backend could not
 *  answer rejects with `files.storageReadFailed` (503) — it is never answered from a stale copy. */
export async function getBlob(key: string): Promise<Blob | null> {
  try {
    return await backend.get(key);
  } catch (e) {
    throw storageError(e, 'read', key);
  }
}

/** DELETE the original bytes for a file at `key` (idempotent; throws on a real failure). */
export function deleteBlob(key: string): Promise<void> {
  return backend.del(key);
}

/** Test hook: drop the in-memory blobs and reset to the default backend. */
export function __resetBlobs(): void {
  mem().clear();
  backend = memoryBackend;
  mode = 'memory';
}
