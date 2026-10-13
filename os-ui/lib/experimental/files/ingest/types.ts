/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileKind } from '../asset-schema.ts';

/**
 * Ingest-by-type — the ONE `apply → verify` interface every file type plugs into
 * (handover §ingest). A document goes to Docling, audio/video to a transcriber,
 * images to OCR/caption, spreadsheets to a table reader — but they all emit the
 * SAME shape: unit-chunked text, each chunk content-hashed (the cache key that
 * lets the pipeline skip re-embedding unchanged content).
 *
 * Each adapter has a MOCK implementation (deterministic, for kind + unit tests)
 * and a LIVE implementation (calls the real service, falls back to the mock when
 * unreachable) behind this identical interface — the agent-runtime dual pattern.
 *
 * Pure module (no server/network) so the pipeline + tests share the contract and
 * the chunk/hash helpers.
 */

export type RepresentationType = 'text' | 'transcript' | 'caption' | 'ocr' | 'table';

/** One indexed unit (a section / clause / slide / paragraph / utterance). */
export type Chunk = { id: string; unit: string; text: string; hash: string };

export type Representation = { type: RepresentationType; chunks: Chunk[] };

export type IngestInput = {
  fileId: string;
  name: string;
  kind: FileKind;
  /** The MOCK object-store body (extracted text / transcript / caption seed). In a
   *  live deploy the adapter fetches the bytes from `deepLink` instead. */
  text: string;
  deepLink: string;
};

export type IngestMode = 'live' | 'mock';

export type IngestResult = {
  adapter: string;
  mode: IngestMode;
  representations: Representation[];
};

export interface IngestAdapter {
  name: string;
  kinds: FileKind[];
  apply(input: IngestInput): Promise<IngestResult>;
  /** Structural verification of an apply() output (the "verify" half). */
  verify(result: IngestResult): boolean;
}

// --------------------------------------------------------------- helpers -------

/** Cheap deterministic content hash (the content-hash cache key). Identical to
 *  the store's so a chunk's hash is stable across the upload + the pipeline. */
export function hashOf(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Split text into units (sentence/line-ish), deterministic + stable. Empty text
 *  yields no chunks (an un-parseable / empty file indexes nothing). */
export function chunkText(text: string, fileId: string, unitLabel = 'unit'): Chunk[] {
  const pieces = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return pieces.map((text, i) => ({
    id: `${fileId}#${i}`,
    unit: `${unitLabel}-${i}`,
    text,
    hash: hashOf(text),
  }));
}

/** A well-formed result has ≥1 representation and every chunk carries text + hash. */
export function verifyResult(result: IngestResult): boolean {
  if (!result.representations.length) return false;
  return result.representations.every(
    (r) => r.chunks.length > 0 && r.chunks.every((c) => c.text.length > 0 && /^[0-9a-f]{8}$/.test(c.hash)),
  );
}
