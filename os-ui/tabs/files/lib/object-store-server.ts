/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { putObject, getObject, deleteObject } from '@tabs/data/lib/object-store';
import { memoryBackend, setBlobBackend, type BlobBackend, type BlobStoreMode } from '@tabs/files/lib/object-store';
import { setHealthWarning } from '@core/infra/health-warnings';

/**
 * The SERVER blob backend for the Files tab: durable MinIO / STACKIT Object Storage under the
 * governed `files` bucket, reusing the SAME SigV4 client the Data path uses (no new creds,
 * path-style, `S3_ENDPOINT`/`S3_*`). Importing this module registers it.
 *
 * NO SILENT FALLBACK. A PUT object storage did not confirm throws, and `putBlob` turns that into
 * the typed `files.storageWriteFailed` — the upload fails and the caller records nothing. A GET it
 * could not answer throws too (`files.storageReadFailed`): no stale in-process copy is served as if
 * it were persisted. (Before: every PUT was also parked in memory and a failed durable PUT only
 * logged a warning, so the upload looked saved and vanished on the next restart.)
 *
 * The in-process store is used ONLY in the explicit `FILES_BLOB_STORE=memory` mode (laptop / demo),
 * which is logged once at startup and raised as a health warning (/api/status) and reported on
 * /api/health. Missing credentials are NOT a memory mode: the writes then fail loudly.
 */

export type ObjectStoreCalls = {
  putObject: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
  getObject: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
  deleteObject: (key: string) => Promise<unknown>;
};

/** Object storage only. Every failure propagates; nothing is kept in this process. */
export function makeS3BlobBackend(s3: ObjectStoreCalls): BlobBackend {
  return {
    async put(key, body, contentType) {
      await s3.putObject(key, body, contentType);
    },
    async get(key) {
      return s3.getObject(key); // null only for a real 404 (absent object)
    },
    async del(key) {
      // Fatal on failure: if object storage can't confirm the removal, the caller flags a physical
      // orphan rather than claim a clean purge (physical-delete.ts).
      await s3.deleteObject(key);
    },
  };
}

/** `memory` only when chosen explicitly; otherwise object storage. */
export function resolveBlobStoreMode(c: { filesBlobStore: string; awsAccessKeyId: string; awsSecretAccessKey: string }): BlobStoreMode {
  return c.filesBlobStore.trim().toLowerCase() === 'memory' ? 'memory' : 'object-storage';
}

export const FILES_BLOB_STORE_WARNING = 'files-blob-store';

const REGISTERED = Symbol.for('soa.files.blobBackendRegistered');

function register(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  const mode = resolveBlobStoreMode(config);
  if (mode === 'memory') {
    setBlobBackend(memoryBackend, 'memory');
    const msg = 'Files: uploaded originals are kept in memory only (FILES_BLOB_STORE=memory) — they are lost when os-ui restarts.';
    setHealthWarning(FILES_BLOB_STORE_WARNING, msg);
    if (!g[REGISTERED]) console.warn(`[files] ${msg}`);
  } else {
    setBlobBackend(makeS3BlobBackend({
      putObject: (k, b, ct) => putObject(k, b, ct, config.filesBucket),
      getObject: (k) => getObject(k, config.filesBucket),
      deleteObject: (k) => deleteObject(k, config.filesBucket),
    }), 'object-storage');
    if (!config.awsAccessKeyId || !config.awsSecretAccessKey) {
      const msg = 'Files: object storage has no credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) — uploads will fail. Set them, or set FILES_BLOB_STORE=memory for a laptop/demo install.';
      setHealthWarning(FILES_BLOB_STORE_WARNING, msg);
      if (!g[REGISTERED]) console.warn(`[files] ${msg}`);
    } else if (!g[REGISTERED]) {
      console.log(`[files] uploaded originals are stored in object storage (bucket "${config.filesBucket}")`);
    }
  }
  g[REGISTERED] = true;
}

register();
