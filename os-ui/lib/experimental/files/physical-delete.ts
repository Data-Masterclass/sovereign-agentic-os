/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileRecord } from './store.ts';
import { objectKeyForAsset } from './store.ts';
import { parseAsset } from './asset-schema.ts';

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
