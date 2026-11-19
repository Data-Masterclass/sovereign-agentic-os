/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Docling client — send a document's BYTES, get its text back, or a typed reason
 * USER STORY: As someone who uploaded a PDF I want its real text read by the parser that runs in
 *             my cluster, and when that cannot happen I want to be told exactly why — never to be
 *             handed text the document does not contain.
 * ARCHITECTURE:
 *   - THE REAL API, pinned. docling-serve 1.25 (the image the chart ships) has NO `/convert`. Its
 *     routes are `/v1/convert/file[/async]` (multipart, field `files`), `/v1/status/poll/{id}`
 *     and `/v1/result/{id}`; the reply is `{ document: { md_content }, status, errors }`. The
 *     previous adapter posted JSON `{ source: 's3://…' }` to `/convert` — a route that does not
 *     exist, with a URI Docling could not have fetched anyway. `docling-client.test.ts` pins the
 *     path, method and field names observed against the live service on 2026-11-19.
 *   - BYTES, not a link. The object store is private; Docling has no credentials for it and must
 *     not get any. The server reads the object and uploads it.
 *   - ASYNC + POLL, always. The synchronous route holds one HTTP request open for the whole
 *     conversion; an OCR pass over a long scan outlives any sane request timeout. Submit returns a
 *     task id at once, `status/poll?wait=N` long-polls (it returns on ANY status change, so it is
 *     looped), and one overall deadline bounds the lot.
 *   - A TYPED OUTCOME, never an exception and never a stand-in. Every way this can fail maps to
 *     one {@link ExtractionFailureCode}; there is no mock branch in this file at all, so no
 *     setting of `OS_OFFLINE_MOCK` can make it invent a document.
 *   - Pure + injectable (`fetchImpl`, `baseUrl`, `now`, `sleep`): no `server-only`, no config
 *     import, so the unit tests and a one-off live check drive the same code the server runs.
 */
import type { ExtractionFailureCode } from '@tabs/files/lib/asset-schema';

/** Extensions docling-serve accepts AND that are not already plain text to us. */
const DOCLING_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'epub']);
const DOCLING_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/epub+zip',
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Is this a binary document the parser can read? Decided by the file NAME first (the stored
 * content-type of a browser upload is often `application/octet-stream`), then by content-type for
 * a name with no usable extension. Legacy `.doc/.ppt/.xls` are NOT accepted by Docling.
 */
export function doclingCanParse(name: string, contentType?: string | null): boolean {
  const ext = extOf(name);
  if (DOCLING_EXTENSIONS.has(ext)) return true;
  if (ext) return false; // a known-other extension wins over a generic content-type
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return DOCLING_CONTENT_TYPES.has(type);
}

export type DoclingDocument = { name: string; bytes: Buffer | Uint8Array; contentType?: string | null };

export type DoclingOutcome =
  | { ok: true; text: string; seconds: number }
  | { ok: false; code: ExtractionFailureCode; reason: string; seconds: number };

export type DoclingOptions = {
  baseUrl: string;
  /** Whole-conversion deadline: submit + every poll + the result fetch. */
  timeoutMs?: number;
  /** Seconds one long-poll may wait server-side. */
  pollWaitSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const DOCLING_SUBMIT_PATH = '/v1/convert/file/async';
export const DOCLING_STATUS_PATH = '/v1/status/poll';
export const DOCLING_RESULT_PATH = '/v1/result';
/** The multipart field docling-serve reads the upload from (plural — it accepts several). */
export const DOCLING_FILE_FIELD = 'files';

const DONE = new Set(['success', 'partial_success']);
const FAILED = new Set(['failure', 'skipped']);

/** `status: 0` = no HTTP answer at all; `error` then says whether we gave up or the socket did. */
type Reply = { status: number; json: Record<string, unknown> | null; error?: 'timeout' | 'network'; detail?: string };

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Reply> {
  if (ms <= 0) return { status: 0, json: null, error: 'timeout', detail: 'deadline reached' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    return { status: 0, json: null, error: aborted ? 'timeout' : 'network', detail: (e as Error)?.message || 'no response' };
  } finally {
    clearTimeout(timer);
  }
}

function detailOf(json: Record<string, unknown> | null): string {
  if (!json) return '';
  const failure = json.failure as { message?: unknown } | null | undefined;
  const parts = [json.error_message, failure?.message, json.detail]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (Array.isArray(json.errors)) {
    for (const e of json.errors as { error_message?: unknown }[]) {
      if (typeof e?.error_message === 'string' && e.error_message) parts.push(e.error_message);
    }
  }
  return parts.join('; ').slice(0, 300);
}

/**
 * Convert ONE document to markdown. Resolves — it never throws — with the text or a typed reason.
 */
export async function convertWithDocling(doc: DoclingDocument, opts: DoclingOptions): Promise<DoclingOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollWait = Math.max(1, Math.min(opts.pollWaitSeconds ?? 20, 60));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const started = now();
  const left = () => timeoutMs - (now() - started);
  const secs = () => Math.round((now() - started) / 100) / 10;
  const fail = (code: ExtractionFailureCode, reason: string): DoclingOutcome => ({ ok: false, code, reason, seconds: secs() });
  const unreachable = (what: string, r: Reply): DoclingOutcome =>
    r.status === 0 && r.error === 'timeout'
      ? fail('parser-timeout', `The document parser (Docling) did not ${what} within ${Math.round(timeoutMs / 1000)} s.`)
      : fail(
          'parser-unreachable',
          `The document parser (Docling) at ${base} could not be reached` +
            `${r.status === 0 ? ` (${r.detail})` : ` (HTTP ${r.status}${detailOf(r.json) ? `: ${detailOf(r.json)}` : ''})`}.`,
        );

  // ---- submit ---------------------------------------------------------------
  const form = new FormData();
  const type = (doc.contentType ?? '').split(';')[0].trim() || 'application/octet-stream';
  form.append(DOCLING_FILE_FIELD, new Blob([new Uint8Array(doc.bytes)], { type }), doc.name);
  form.append('to_formats', 'md');
  form.append('do_ocr', 'true');
  // Picture bitmaps are megabytes of base64 nobody reads; a placeholder keeps the reply text-sized.
  form.append('image_export_mode', 'placeholder');
  const submit = await call(fetchImpl, `${base}${DOCLING_SUBMIT_PATH}`, { method: 'POST', body: form, headers: { accept: 'application/json' } }, Math.min(left(), 120_000));
  if (submit.status === 422) {
    return fail('parser-error', `The document parser (Docling) rejected the upload${detailOf(submit.json) ? `: ${detailOf(submit.json)}` : ''}.`);
  }
  if (submit.status !== 200 || !submit.json) return unreachable('accept the document', submit);
  const taskId = typeof submit.json.task_id === 'string' ? submit.json.task_id : '';
  if (!taskId) return fail('parser-error', 'The document parser (Docling) accepted the upload but returned no task id.');

  // ---- poll -----------------------------------------------------------------
  let status = String(submit.json.task_status ?? 'pending');
  let last: Record<string, unknown> | null = submit.json;
  let misses = 0;
  while (!DONE.has(status) && !FAILED.has(status)) {
    if (left() <= 0) {
      return fail('parser-timeout', `The document parser (Docling) did not finish within ${Math.round(timeoutMs / 1000)} s (last status: ${status}).`);
    }
    const wait = Math.max(1, Math.min(pollWait, Math.floor(left() / 1000)));
    const poll = await call(
      fetchImpl,
      `${base}${DOCLING_STATUS_PATH}/${encodeURIComponent(taskId)}?wait=${wait}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      Math.min(left(), wait * 1000 + 10_000),
    );
    if (poll.status === 200 && poll.json) {
      misses = 0;
      last = poll.json;
      const next = String(poll.json.task_status ?? status);
      // The long-poll returns on ANY change (pending → started), and at once when nothing is
      // pending server-side; a short pause keeps an unchanged status from becoming a busy loop.
      if (next === status) await sleep(500);
      status = next;
      continue;
    }
    if (poll.status === 404) return fail('parser-error', 'The document parser (Docling) lost the conversion task (it was probably restarted).');
    misses += 1;
    if (misses >= 3) return unreachable('report the conversion status', poll);
    await sleep(1000);
  }
  if (FAILED.has(status)) {
    return fail('parser-error', `The document parser (Docling) could not convert this document (${status}${detailOf(last) ? `: ${detailOf(last)}` : ''}).`);
  }

  // ---- result ---------------------------------------------------------------
  const result = await call(
    fetchImpl,
    `${base}${DOCLING_RESULT_PATH}/${encodeURIComponent(taskId)}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    Math.max(1000, Math.min(left(), 60_000)),
  );
  if (result.status !== 200 || !result.json) return unreachable('return the converted text', result);
  const docStatus = String(result.json.status ?? '');
  const document = (result.json.document ?? {}) as Record<string, unknown>;
  const raw = typeof document.md_content === 'string' ? document.md_content : typeof document.text_content === 'string' ? document.text_content : '';
  const text = raw.replace(/<!--\s*image\s*-->/g, '').trim();
  if (FAILED.has(docStatus) || (!text && docStatus && !DONE.has(docStatus))) {
    return fail('parser-error', `The document parser (Docling) could not read this document (${docStatus || 'no status'}${detailOf(result.json) ? `: ${detailOf(result.json)}` : ''}). It may be corrupt or password-protected.`);
  }
  if (!text) {
    return fail('no-text', 'The document parser (Docling) read the document and found no text in it — for example a scan on which OCR recognised nothing.');
  }
  return { ok: true, text, seconds: secs() };
}
