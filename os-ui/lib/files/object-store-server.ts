/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { putObject, getObject } from '@/lib/data/object-store';
import { memoryBackend, setBlobBackend, type BlobBackend } from './object-store.ts';

/**
 * The SERVER blob backend for the Files tab: durable MinIO / STACKIT Object Storage
 * under the governed `files` bucket, reusing the SAME SigV4 client the Data path uses
 * (no new creds, path-style, `S3_ENDPOINT`/`S3_*`). The in-process `memoryBackend` is
 * the best-effort fallback so a MinIO hiccup never yields an EMPTY download — the same
 * durable-with-fallback contract as osMirror. Importing this module registers it.
 */
const s3Backend: BlobBackend = {
  async put(key, body, contentType) {
    // Always keep an in-process copy so the download works this session even if the
    // durable PUT below fails; then attempt the durable write.
    await memoryBackend.put(key, body, contentType);
    if (!config.awsAccessKeyId || !config.awsSecretAccessKey) return; // memory-only (laptop)
    try {
      await putObject(key, body, contentType, config.filesBucket);
    } catch (e) {
      // Honest, non-fatal: the bytes are in-process; report and carry on.
      console.warn(`[files] durable object PUT failed (served from memory): ${(e as Error).message}`);
    }
  },
  async get(key) {
    if (config.awsAccessKeyId && config.awsSecretAccessKey) {
      try {
        const durable = await getObject(key, config.filesBucket);
        if (durable) return durable;
      } catch (e) {
        console.warn(`[files] durable object GET failed (falling back to memory): ${(e as Error).message}`);
      }
    }
    return memoryBackend.get(key);
  },
};

setBlobBackend(s3Backend);
