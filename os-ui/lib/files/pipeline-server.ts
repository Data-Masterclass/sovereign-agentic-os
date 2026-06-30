/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { indexAsset } from '@/lib/files/index-pipeline';
import { listAllForIndex, bodyForIndex } from '@/lib/files/store';
import { recordLineage } from '@/lib/files/lineage';
import type { FileAsset } from '@/lib/files/asset-schema';

/**
 * Server boundary for the auto-index pipeline. The routes call these after an
 * upload / edit / promotion so the hybrid index stays current; the pure pipeline
 * (index-pipeline.ts) does the work and the LIVE adapters/embedder self-fall-back
 * to their mocks when the services are off (kind). `live: true` also mirrors the
 * chunks to OpenSearch on a real deploy.
 */

let bootstrapped = false;

/** Index every stored file once, so seeds + anything uploaded before the index
 *  existed are retrievable. Idempotent (content-hash cache skips unchanged chunks). */
export async function bootstrapFilesIndex(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const { asset, text } of listAllForIndex()) {
    await indexAsset(asset, text, { live: true }).catch(() => undefined);
  }
}

/** Re-index a single file after an edit. Records a `file_indexed` lineage edge when
 *  it becomes searchable (the file → index edge, OM/mock-tolerant). */
export async function reindexFile(asset: FileAsset, text: string): Promise<void> {
  const report = await indexAsset(asset, text, { live: true }).catch(() => null);
  if (report && report.status === 'searchable') {
    recordLineage({ kind: 'file_indexed', fileId: asset.id, fileName: asset.name, target: `${asset.id}#chunks(${report.indexed})`, by: asset.owner });
  }
}

/** Re-index by id (fetches the current body server-side). */
export async function reindexById(id: string): Promise<void> {
  const body = bodyForIndex(id);
  if (body) await reindexFile(body.asset, body.text);
}
