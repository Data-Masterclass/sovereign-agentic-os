/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileKind } from '../asset-schema.ts';
import {
  type IngestAdapter,
  type IngestInput,
  type IngestResult,
  type Representation,
  chunkText,
  verifyResult,
} from './types.ts';

/**
 * The deterministic MOCK ingest adapters (kind + unit tests). Each maps a file's
 * extracted-text seed into the representation its type would really produce —
 * Docling→text, transcribe→transcript, OCR→caption+ocr, table→table — chunked by
 * unit + hashed. No network; identical output every run.
 */

function mockAdapter(name: string, kinds: FileKind[], build: (i: IngestInput) => Representation[]): IngestAdapter {
  return {
    name,
    kinds,
    async apply(input: IngestInput): Promise<IngestResult> {
      return { adapter: name, mode: 'mock', representations: build(input) };
    },
    verify: verifyResult,
  };
}

/** Docling — documents (pdf/doc/txt/md/slides) → text in reading order. */
export const doclingMock = mockAdapter('docling', ['doc', 'archive', 'other'], (i) => [
  { type: 'text', chunks: chunkText(i.text, i.fileId, 'section') },
]);

/** Transcribe — audio/video → a transcript. */
export const transcribeMock = mockAdapter('transcribe', ['audio', 'video'], (i) => [
  { type: 'transcript', chunks: chunkText(i.text, i.fileId, 'utterance') },
]);

/** OCR + caption — images → a caption and any embedded text. */
export const ocrCaptionMock = mockAdapter('ocr-caption', ['image'], (i) => {
  const chunks = chunkText(i.text, i.fileId, 'region');
  return [
    { type: 'caption', chunks: chunks.slice(0, 1) },
    { type: 'ocr', chunks: chunks.length > 1 ? chunks.slice(1) : chunks },
  ];
});

/** Table — spreadsheets/CSV → a flattened table representation + text. */
export const tableMock = mockAdapter('table', ['table'], (i) => [
  { type: 'table', chunks: chunkText(i.text, i.fileId, 'row') },
]);

const ALL = [doclingMock, transcribeMock, ocrCaptionMock, tableMock];

/** Pick the adapter for a kind (docling is the catch-all for unknown types). */
export function mockAdapterFor(kind: FileKind): IngestAdapter {
  return ALL.find((a) => a.kinds.includes(kind)) ?? doclingMock;
}
