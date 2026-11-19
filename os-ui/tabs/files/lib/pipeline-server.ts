/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { indexAsset } from '@tabs/files/lib/index-pipeline';
import { actingCaller, type EmbedCaller } from '@tabs/files/lib/embed';
import { listAllForIndex, bodyForIndex, extractionSubject } from '@tabs/files/lib/store';
import { config } from '@core/kernel/config';
import { getBlob } from '@tabs/files/lib/object-store';
import '@tabs/files/lib/object-store-server'; // registers the durable MinIO backend
import { convertWithDocling } from '@tabs/files/lib/ingest/docling-client';
import { extractFileText, settleStaleExtraction, type ExtractDeps, type ExtractResult } from '@tabs/files/lib/extract';
import { recordLineage } from '@tabs/files/lib/lineage';
import type { FileAsset } from '@tabs/files/lib/asset-schema';

/**
 * Server boundary for the auto-index pipeline. The routes call these after an
 * upload / edit / promotion so the hybrid index stays current; the pure pipeline
 * (index-pipeline.ts) does the work and the LIVE adapters/embedder self-fall-back
 * to their mocks when the services are off (kind). `live: true` also mirrors the
 * chunks to OpenSearch on a real deploy.
 */

let bootstrapped = false;

/**
 * ATTRIBUTION (checklist A27). `reindexFile` / `reindexById` take the ACTING user's id and bill
 * the embed calls to that principal with the ASSET's domain. A door that genuinely has no acting
 * user — the boot sweep below, a scheduled connector sync — passes nothing and keeps the platform
 * attribution, which is the truth for that work.
 */
function callerFor(asset: FileAsset, actingUserId?: string): EmbedCaller | undefined {
  return actingUserId ? actingCaller(actingUserId, asset.domain) : undefined;
}

/** Index every stored file once, so seeds + anything uploaded before the index
 *  existed are retrievable. Idempotent (content-hash cache skips unchanged chunks).
 *  NO acting user by design: this is a platform sweep and is billed as one. */
export async function bootstrapFilesIndex(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const { asset, text } of listAllForIndex()) {
    await indexAsset(asset, text, { live: true }).catch(() => undefined);
  }
}

/** Re-index a single file after an edit. Records a `file_indexed` lineage edge when
 *  it becomes searchable (the file → index edge). */
export async function reindexFile(asset: FileAsset, text: string, actingUserId?: string): Promise<void> {
  const report = await indexAsset(asset, text, { live: true, caller: callerFor(asset, actingUserId) }).catch(() => null);
  if (report && report.status === 'searchable') {
    recordLineage({ kind: 'file_indexed', fileId: asset.id, fileName: asset.name, target: `${asset.id}#chunks(${report.indexed})`, by: asset.owner });
  }
}

/** The live extraction wiring: the real Docling, the real object store, the ordinary indexer. */
export const LIVE_EXTRACT_DEPS: ExtractDeps = {
  convert: (doc) => convertWithDocling(doc, { baseUrl: config.doclingUrl, timeoutMs: config.doclingTimeoutMs }),
  getBlob,
  index: reindexFile,
};

/**
 * Read a stored binary document's text through Docling, store it on the file and index it.
 * `waitMs` bounds how long the CALLER waits (the work itself carries on in this process up to
 * `DOCLING_TIMEOUT_MS`); omit it to wait for the result. A file that is restricted, opted out,
 * already has text or is not a parseable document is `skipped` and never leaves the store.
 */
export function extractText(id: string, opts: { waitMs?: number; actingUserId?: string } = {}): Promise<ExtractResult> {
  settleStale(id);
  return extractFileText(id, LIVE_EXTRACT_DEPS, opts);
}

/** Turn a `pending` extraction nobody is running any more into an honest `interrupted`. */
export function settleStale(id: string): void {
  settleStaleExtraction(id, config.doclingTimeoutMs + 60_000);
}

/**
 * THE one call an upload door makes once the record exists and its bytes are in the object
 * store: text already in hand ⇒ index it; none ⇒ try to read it from the bytes (bounded wait).
 * Returns the file as it stands afterwards, so the response shows the real state — Searchable,
 * still extracting, or Stored only with the reason.
 */
export async function ingestUploaded(asset: FileAsset, text: string, actingUserId?: string): Promise<FileAsset> {
  if (text.trim()) {
    await reindexFile(asset, text, actingUserId);
    return asset;
  }
  await extractText(asset.id, { waitMs: config.uploadExtractWaitMs, actingUserId });
  return bodyForIndex(asset.id)?.asset ?? asset;
}

/**
 * Re-index by id (fetches the current body server-side).
 *
 * When the owner has asked for the file to be INDEXED and it has no text on record but does
 * have parseable bytes ("Index this file" / "Extract text" on a PDF), indexing nothing and
 * calling it searchable would be a lie — so the text is extracted first. A file that is merely
 * stored-only is NOT re-parsed by an unrelated edit (a rename must not start an OCR run).
 */
export async function reindexById(id: string, actingUserId?: string): Promise<void> {
  const subject = extractionSubject(id);
  if (subject && subject.asset.indexing.mode === 'indexed' && subject.eligibility.eligible) {
    await extractText(id, { waitMs: config.uploadExtractWaitMs, actingUserId });
    return;
  }
  const body = bodyForIndex(id);
  if (body) await reindexFile(body.asset, body.text, actingUserId);
}
