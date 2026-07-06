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
 *   • default backend = an in-process Map (always works; used by tests + offline).
 *   • the server registers a MinIO-backed backend (object-store-server.ts) that
 *     reuses the SAME SigV4 client the Data path uses, with the memory backend as a
 *     best-effort fallback (mirrors the osMirror durable-with-fallback pattern).
 *
 * Keys are the object key WITHIN the governed `files` bucket, i.e. the store's prefix
 * invariant minus `s3://files/` — `<owner|domain>/<folder>/<name>`. The bucket itself
 * is the backend's concern.
 */

export type Blob = { body: Buffer; contentType: string };

export interface BlobBackend {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
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
};

let backend: BlobBackend = memoryBackend;

/** Install the durable backend (called by the server module). */
export function setBlobBackend(b: BlobBackend): void {
  backend = b;
}

/** PUT the original bytes for a file at `key`. */
export function putBlob(key: string, body: Buffer, contentType: string): Promise<void> {
  return backend.put(key, body, contentType);
}

/** GET the original bytes for a file at `key` (or `null` when absent). */
export function getBlob(key: string): Promise<Blob | null> {
  return backend.get(key);
}

/** Test hook: drop the in-memory blobs and reset to the default backend. */
export function __resetBlobs(): void {
  mem().clear();
  backend = memoryBackend;
}
