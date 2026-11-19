/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '@core/kernel/config';
import type { FileKind } from '@tabs/files/lib/asset-schema';
import {
  type IngestAdapter,
  type IngestInput,
  type IngestResult,
  type Representation,
  type RepresentationType,
  chunkText,
  hashOf,
  verifyResult,
} from '@tabs/files/lib/ingest/types';
import { mockAdapterFor } from '@tabs/files/lib/ingest/mocks';
import { offlineMockAllowed, refuseOfflineMock } from '@core/kernel/offline-mock';

/**
 * LIVE ingest adapters — real `apply → verify` behind the SAME interface as the mocks.
 * Documents and tables represent the file's STORED text (see `storedTextAdapter` below; the
 * Docling call itself lives in `ingest/docling-client.ts` + `extract.ts`). Audio/video and
 * images still call their service here (a Whisper-style ASR, an OCR/caption service); when
 * that is unreachable (kind, or the service is off) they fall back to the deterministic MOCK
 * and label the result `mode: 'mock'` — honest, never a silent failure. This is the
 * agent-runtime dual pattern (lib/agents/build/live).
 *
 * THE HONESTY GATE (2026-11-18, review H2). The fallback produced INVENTED TEXT for the file —
 * placeholder sections, a placeholder transcript, a placeholder caption — which was then chunked,
 * embedded and indexed, so Knowledge retrieval and any agent reading the file quoted content the
 * document does not contain. It was labelled `mode: 'mock'`, which is a different string from
 * `offline-mock`, so the original tripwire never looked here. Unless this deployment explicitly
 * asked for the teaching flow, an unreachable parser is now refused: no representations, nothing
 * indexed, a typed ENGINE_UNAVAILABLE.
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
      // Honest fallback: the deterministic mock, labelled mode: 'mock' — but ONLY where a
      // worked example is the point. Everywhere else, inventing the contents of somebody's
      // document is the worst thing this pipeline could do, so it refuses.
      if (!offlineMockAllowed()) {
        refuseOfflineMock(
          `Cannot ingest “${input.name}”: the ${name} service at ${url} is ` +
            'unreachable or returned nothing usable, so the file was not parsed. No text, no ' +
            'chunks and no embeddings were produced, and nothing was indexed.',
        );
      }
      return mockAdapterFor(input.kind).apply(input);
    },
    verify: verifyResult,
  };
}

/**
 * A document / table adapter that represents the file's STORED TEXT (2026-11-19).
 *
 * It makes no network call, on purpose. A document reaches the index in two steps now:
 *   1. its text is obtained ONCE and stored on the file — a text-like upload's bytes ARE its
 *      text; a binary document (PDF/DOCX/PPTX/XLSX) is sent to Docling as bytes by
 *      `extract.ts`, which stores the markdown it returns or a typed reason it could not;
 *   2. this adapter chunks + hashes that stored text.
 * So `get_file`, the preview, lexical search and the vector index all read ONE body, and a
 * re-index does not pay for a second OCR pass. The previous version posted
 * `{ source: 's3://…' }` to `{DOCLING_URL}/convert` here — a route docling-serve does not have —
 * so on a deployed cluster EVERY file (plain text included) was refused from the index.
 *
 * HONESTY: there is no stand-in to refuse any more, because nothing here can invent. The text is
 * the file's own or the parser's; when there is none the result carries NO representation, the
 * pipeline reports `empty`, and nothing is indexed. `mode: 'live'` is therefore the truth — the
 * chunks are real content, never a placeholder. The "parser unreachable" refusal moved to where
 * the parser is actually called: `extract.ts` records it on the file as a typed failure.
 */
function storedTextAdapter(name: string, kinds: FileKind[], type: RepresentationType, unit: string): IngestAdapter {
  return {
    name,
    kinds,
    async apply(input: IngestInput): Promise<IngestResult> {
      const chunks = chunkText(input.text, input.fileId, unit);
      return { adapter: name, mode: 'live', representations: chunks.length ? [{ type, chunks }] : [] };
    },
    verify: verifyResult,
  };
}

/** Documents: the stored text (the upload's own, or Docling's markdown) in reading order. */
export const doclingLive = storedTextAdapter('docling', ['doc', 'archive', 'other'], 'text', 'section');

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

/** Tables: the stored text (CSV/TSV as uploaded; XLSX as Docling's markdown table), row-chunked. */
export const tableLive = storedTextAdapter('table', ['table'], 'table', 'row');

const ALL = [doclingLive, transcribeLive, ocrCaptionLive, tableLive];

export function liveAdapterFor(kind: FileKind): IngestAdapter {
  return ALL.find((a) => a.kinds.includes(kind)) ?? doclingLive;
}
