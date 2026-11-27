/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Store an uploaded file's ORIGINAL bytes as a private file and index it
 * USER STORY: As a user I want a file I upload — from the Files tab or by attaching it to a chat
 *             message — stored byte-for-byte in my My scope and made searchable (Docling reads
 *             PDF/DOCX/PPTX/XLSX), through one path so both doors behave the same.
 * ARCHITECTURE:
 *   - The binary half of `POST /api/files` (multipart and raw-body branches), lifted out of the
 *     route so the chat attachment door (`os-ui/chat-attachment-sinks.ts`) calls the SAME code:
 *     governed `createFile` → object-store put under the file's prefix → `attachObject` (a failed put
 *     fails the upload and removes the record — `blob-writes.ts`) →
 *     `ingestUploaded` (index text in hand, or Docling from the stored bytes, bounded).
 *   - Callers check size and run the OPA create decision BEFORE calling this.
 */
import 'server-only';
import type { Principal } from '@core/kernel/route-server';
import { createFile } from '@tabs/files/lib/store';
import { storeNewFileBytes } from '@tabs/files/lib/blob-writes';
import '@tabs/files/lib/object-store-server'; // registers the durable MinIO backend
import { ingestUploaded } from '@tabs/files/lib/pipeline-server';
import type { FileAsset, Sensitivity } from '@tabs/files/lib/asset-schema';

/** True when a file's bytes should also be kept as indexable extracted text. */
export function isTextLike(name: string, type: string): boolean {
  return /^text\//.test(type) || /json|csv|xml|markdown|yaml/.test(type) || /\.(txt|md|csv|tsv|json|log|xml|yaml|yml)$/i.test(name);
}

export async function storeUploadedFile(
  user: Principal,
  input: { name: string; folder?: string; tags?: string[]; sensitivity?: Sensitivity; bytes: Buffer; contentType?: string },
): Promise<FileAsset> {
  const fileType = input.contentType || 'application/octet-stream';
  // A text-like file's bytes ARE its text. A binary document's text is read from the
  // stored bytes by the parser AFTER the object is in the store (ingestUploaded below).
  const text = isTextLike(input.name, fileType) ? input.bytes.toString('utf8') : '';
  const asset = createFile(user, { name: input.name, folder: input.folder ?? '/', tags: input.tags ?? [], sensitivity: input.sensitivity, text, bytes: input.bytes.length });
  // Persist the original bytes under the file's governed prefix, then record them. A write object
  // storage did not confirm fails the upload (`files.storageWriteFailed`) and removes the record.
  await storeNewFileBytes(asset, user, input.bytes, fileType);
  // Text in hand ⇒ index it. None (a PDF/DOCX/…) ⇒ read it from the stored bytes via
  // Docling, bounded: the result shows Searchable, still-extracting, or the reason.
  return ingestUploaded(asset, text, user.id); // A27: the uploader pays for the embed
}
