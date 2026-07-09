/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../../core/config.ts';
import type { FileKind } from '../asset-schema.ts';
import {
  type IngestAdapter,
  type IngestInput,
  type IngestResult,
  type Representation,
  type RepresentationType,
  chunkText,
  hashOf,
  verifyResult,
} from './types.ts';
import { mockAdapterFor } from './mocks.ts';

/**
 * LIVE ingest adapters — real `apply → verify` against the actual services, behind
 * the SAME interface as the mocks. When the service is reachable the file is parsed
 * for real (Docling for docs, a Whisper-style ASR for audio/video, an OCR/caption
 * service for images); when it is unreachable (kind, or the service is off) we fall
 * back to the deterministic MOCK and label the result `mode: 'mock'` — honest, never
 * a silent failure. This is the agent-runtime dual pattern (lib/agents/build/live).
 *
 * server-only: it makes outbound calls, so it is imported by the pipeline's server
 * boundary, not by the pure store/tests (those use the mocks + injected fakes).
 */

async function post(url: string, body: unknown, ms = 8000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a service's returned text blocks into a representation (chunk + hash). */
function toRepresentation(type: RepresentationType, fileId: string, unit: string, blocks: string[]): Representation {
  const chunks = blocks
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `${fileId}#${i}`, unit: `${unit}-${i}`, text, hash: hashOf(text) }));
  return { type, chunks };
}

/** Build a live adapter that posts to `url` and parses `pick(json)`; falls back to
 *  the matching mock when the service is unreachable or returns nothing usable. */
function liveAdapter(
  name: string,
  kinds: FileKind[],
  url: string,
  type: RepresentationType,
  unit: string,
  payload: (i: IngestInput) => unknown,
  pick: (json: Record<string, unknown>, input: IngestInput) => Representation[],
): IngestAdapter {
  return {
    name,
    kinds,
    async apply(input: IngestInput): Promise<IngestResult> {
      const res = await post(url, payload(input));
      if (res && res.ok) {
        try {
          const json = (await res.json()) as Record<string, unknown>;
          const representations = pick(json, input);
          const result: IngestResult = { adapter: name, mode: 'live', representations };
          if (verifyResult(result)) return result;
        } catch {
          /* fall through to the mock */
        }
      }
      // Honest fallback: the deterministic mock, labelled mode: 'mock'.
      return mockAdapterFor(input.kind).apply(input);
    },
    verify: verifyResult,
  };
}

/** Docling REST: POST {DOCLING_URL}/convert {source} → { document: { texts: [{text}] } }. */
export const doclingLive = liveAdapter(
  'docling', ['doc', 'archive', 'other'], `${config.doclingUrl}/convert`, 'text', 'section',
  (i) => ({ source: i.deepLink, options: { ocr: true } }),
  (json, i) => {
    const doc = (json.document ?? {}) as Record<string, unknown>;
    const texts = Array.isArray(doc.texts) ? (doc.texts as Record<string, unknown>[]).map((t) => String(t.text ?? '')) : [];
    return texts.length ? [toRepresentation('text', i.fileId, 'section', texts)] : [{ type: 'text', chunks: chunkText(i.text, i.fileId, 'section') }];
  },
);

/** ASR (Whisper-style): POST {TRANSCRIBE_URL}/asr {source} → { segments: [{text}] }. */
export const transcribeLive = liveAdapter(
  'transcribe', ['audio', 'video'], `${config.transcribeUrl}/asr`, 'transcript', 'utterance',
  (i) => ({ source: i.deepLink, task: 'transcribe' }),
  (json, i) => {
    const segs = Array.isArray(json.segments) ? (json.segments as Record<string, unknown>[]).map((s) => String(s.text ?? '')) : [];
    return segs.length ? [toRepresentation('transcript', i.fileId, 'utterance', segs)] : [{ type: 'transcript', chunks: chunkText(i.text, i.fileId, 'utterance') }];
  },
);

/** OCR/caption: POST {OCR_URL}/describe {source} → { caption, ocr: [lines] }. */
export const ocrCaptionLive = liveAdapter(
  'ocr-caption', ['image'], `${config.ocrUrl}/describe`, 'caption', 'region',
  (i) => ({ source: i.deepLink }),
  (json, i) => {
    const caption = typeof json.caption === 'string' ? [json.caption] : [];
    const ocr = Array.isArray(json.ocr) ? (json.ocr as unknown[]).map((l) => String(l)) : [];
    const reps: Representation[] = [];
    if (caption.length) reps.push(toRepresentation('caption', i.fileId, 'region', caption));
    if (ocr.length) reps.push(toRepresentation('ocr', i.fileId, 'region', ocr));
    return reps.length ? reps : [{ type: 'caption', chunks: chunkText(i.text, i.fileId, 'region') }];
  },
);

/** Table reader (docling table mode reused). */
export const tableLive = liveAdapter(
  'table', ['table'], `${config.doclingUrl}/convert`, 'table', 'row',
  (i) => ({ source: i.deepLink, options: { tables: true } }),
  (json, i) => {
    const doc = (json.document ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(doc.tables) ? (doc.tables as Record<string, unknown>[]).map((t) => String(t.text ?? '')) : [];
    return rows.length ? [toRepresentation('table', i.fileId, 'row', rows)] : [{ type: 'table', chunks: chunkText(i.text, i.fileId, 'row') }];
  },
);

const ALL = [doclingLive, transcribeLive, ocrCaptionLive, tableLive];

export function liveAdapterFor(kind: FileKind): IngestAdapter {
  return ALL.find((a) => a.kinds.includes(kind)) ?? doclingLive;
}
