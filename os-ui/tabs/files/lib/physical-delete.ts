/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileRecord, Principal } from '@tabs/files/lib/store';
import { objectKeyForAsset, deleteFile } from '@tabs/files/lib/store';
import { parseAsset } from '@tabs/files/lib/asset-schema';
import { removeFromIndex, removeChunksFromMirror } from '@tabs/files/lib/index-store';
import { deleteBlob } from '@tabs/files/lib/object-store';

/**
 * PHYSICAL cleanup for a file DELETE (never for archive — archive is a reversible
 * registry-only soft-hide; restore must bring the file back intact WITH its bytes).
 *
 * Deleting a file removes its registry record AND its object-store (MinIO) bytes: a
 * "deleted" file whose bytes still sit in `s3://files/<owner|domain>/…` isn't
 * deleted. The purge runs through the SAME governed blob backend the upload/download
 * path uses (object-store.ts → the SigV4 client's DeleteObject). If the object store
 * is unreachable the delete still stands, but the orphaned object is REPORTED
 * honestly (`physical[].ok:false`) — never a silent "success".
 *
 * Pure planning (`objectPurgePlan`) + an injected `DeleteFn` executor, so the plan
 * and the outcome fold are unit-testable without MinIO; the route injects the real
 * `deleteBlob`.
 */

/** One physical object this file occupies in the blob store. */
export type ObjectTarget = { key: string };

/** The DeleteObject shape, injected for testability (route passes `deleteBlob`). */
export type DeleteFn = (key: string) => Promise<void>;

export type PhysicalDeleteReport = {
  recordDeleted: boolean;
  physical: { target: string; ok: boolean; reason?: string }[];
};

/**
 * Every object key this file's stored bytes occupy. The record keeps ONE canonical
 * object (`rec.object.key`) — re-uploads (versions) overwrite that same governed key
 * rather than minting a new one — so we resolve the key from the stored object meta,
 * falling back to the asset's governed deep-link. Text-only (MCP) records have no
 * object → nothing to purge.
 */
export function objectPurgePlan(rec: FileRecord): ObjectTarget[] {
  const keys = new Set<string>();
  if (rec.object?.key) keys.add(rec.object.key);
  // Belt-and-braces: also plan the key the asset's deep-link resolves to, in case an
  // older record carried bytes without recording `object` meta. Same governed prefix.
  try {
    const derived = objectKeyForAsset(parseAsset(rec.yaml));
    if (derived) keys.add(derived);
  } catch {
    /* corrupt yaml never blocks the record delete */
  }
  return [...keys].map((key) => ({ key }));
}

/**
 * Purge every planned object, best-effort per object: one failure (store offline)
 * never blocks the others, and every miss is reported as an orphan with its reason.
 * `recordDeleted` is always true here — the caller has already removed the record;
 * this reports only the physical outcome.
 */
export async function purgeFileObjects(rec: FileRecord, del: DeleteFn): Promise<PhysicalDeleteReport> {
  const report: PhysicalDeleteReport = { recordDeleted: true, physical: [] };
  for (const t of objectPurgePlan(rec)) {
    try {
      await del(t.key);
      report.physical.push({ target: t.key, ok: true });
    } catch (e) {
      report.physical.push({ target: t.key, ok: false, reason: (e as Error).message || 'delete failed' });
    }
  }
  return report;
}

/** What a permanent delete did beyond the record: the search chunks and the stored bytes. */
export type PermanentDeleteReport = PhysicalDeleteReport & {
  /** The file's chunks in the OpenSearch search index. `ok:false` = they may still be there. */
  index: { ok: true } | { ok: false; reason: string };
};

export type PermanentDeleteDeps = {
  deleteBlob?: DeleteFn;
  deleteChunks?: (fileId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
};

/**
 * THE permanent delete of a file — the one entry point for the route and the folder cascade, so
 * a folder delete removes exactly what a file delete removes. In order:
 *   1. the RECORD, confirmed by the shared store (`deleteFile`): a refusal throws 503 and nothing
 *      at all is removed — no chunk, no byte — because the file still exists;
 *   2. its SEARCH CHUNKS: this process's in-memory index and the OpenSearch index live search
 *      reads, awaited with a bounded retry;
 *   3. its OBJECT-STORE BYTES (`purgeFileObjects`).
 * Steps 2 and 3 run after the record is gone, so a failure there is REPORTED (`index.ok:false`,
 * `physical[].ok:false`) — the delete stands and the leftover is named, never silent.
 */
export async function deleteFilePermanently(id: string, user: Principal, deps: PermanentDeleteDeps = {}): Promise<PermanentDeleteReport> {
  const rec = await deleteFile(id, user); // throws 403 / 404 / 503 → nothing is purged
  removeFromIndex(id);
  const index = await (deps.deleteChunks ?? ((fileId: string) => removeChunksFromMirror(fileId)))(id);
  const physical = await purgeFileObjects(rec, deps.deleteBlob ?? deleteBlob);
  return { ...physical, index };
}
