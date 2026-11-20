/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Docling client speaks the API docling-serve really has
 * USER STORY: As the owner of twelve unreadable invoices I need the request this code sends to be
 *             the one the parser in my cluster answers — the last one went to a route that does
 *             not exist — and every way it can fail to come back as a reason, never as text.
 * ARCHITECTURE:
 *   - The shapes below were OBSERVED against docling-serve 1.25.0 (`/openapi-3.0.json` + a real
 *     conversion of a generated one-page PDF, 2026-11-19): submit → `{ task_id, task_status }`,
 *     poll → the same shape, result → `{ document: { md_content }, status, errors }`. A corrupt
 *     file answers 200 with `status: 'failure'` and `md_content: null`.
 *   - `fetch` is injected; nothing is stubbed globally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertWithDocling,
  doclingCanParse,
  DOCLING_API_KEY_HEADER,
  DOCLING_FILE_FIELD,
  DOCLING_TABLE_STRUCTURE_PRESET,
  DOCLING_RESULT_PATH,
  DOCLING_STATUS_PATH,
  DOCLING_SUBMIT_PATH,
} from '@tabs/files/lib/ingest/docling-client';

type Call = { url: string; method: string; form: FormData | null; headers: Record<string, string> };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A docling-serve double: one task, a scripted list of statuses, a scripted result. */
function fakeDocling(script: { statuses?: string[]; result?: unknown; resultStatus?: number; submit?: () => Response | Promise<Response> }) {
  const calls: Call[] = [];
  const statuses = [...(script.statuses ?? ['started', 'success'])];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, form: init?.body instanceof FormData ? init.body : null, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (url.endsWith(DOCLING_SUBMIT_PATH)) {
      return script.submit ? script.submit() : json({ task_id: 't-1', task_type: 'convert', task_status: 'pending', task_position: 1 });
    }
    if (url.includes(`${DOCLING_STATUS_PATH}/t-1`)) {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return json({ task_id: 't-1', task_type: 'convert', task_status: s, error_message: null, failure: null });
    }
    if (url.endsWith(`${DOCLING_RESULT_PATH}/t-1`)) {
      return json(
        script.result ?? { document: { filename: 'x.pdf', md_content: 'Invoice INV-1 Total due: 10 EUR' }, status: 'success', errors: [], processing_time: 1 },
        script.resultStatus ?? 200,
      );
    }
    return json({ detail: 'Not Found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PDF = { name: 'invoice.pdf', bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' };
const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  ({ baseUrl: 'http://docling:5001', fetchImpl, sleep: async () => undefined, ...over });

test('THE REQUEST: multipart POST of the BYTES to /v1/convert/file/async, field `files`, markdown out', async () => {
  const d = fakeDocling({});
  const out = await convertWithDocling(PDF, opts(d.fetchImpl));
  assert.equal(out.ok, true);

  const submit = d.calls[0];
  assert.equal(submit.method, 'POST');
  assert.equal(submit.url, 'http://docling:5001/v1/convert/file/async');
  assert.notEqual(submit.url, 'http://docling:5001/convert', 'the route the old adapter posted to does not exist');
  assert.ok(submit.form, 'the body is multipart form data, not JSON with an s3:// link');
  assert.equal(DOCLING_FILE_FIELD, 'files');
  const file = submit.form!.get('files');
  assert.ok(file instanceof File, 'the upload travels in the `files` field');
  assert.equal((file as File).name, 'invoice.pdf');
  assert.equal((file as File).type, 'application/pdf');
  assert.equal(Buffer.from(await (file as File).arrayBuffer()).toString(), '%PDF-1.4 fake', 'the bytes are sent unchanged');
  assert.equal(submit.form!.get('to_formats'), 'md');
  assert.equal(submit.form!.get('do_ocr'), 'true');
  assert.equal(submit.form!.get('source'), null, 'no object-store link is sent — Docling could not fetch it');

  const poll = d.calls[1];
  assert.equal(poll.method, 'GET');
  assert.match(poll.url, /^http:\/\/docling:5001\/v1\/status\/poll\/t-1\?wait=\d+$/);
  const result = d.calls[d.calls.length - 1];
  assert.equal(result.method, 'GET');
  assert.equal(result.url, 'http://docling:5001/v1/result/t-1');
});

test('the long-poll returns on ANY status change, so it is looped until the task is done', async () => {
  const d = fakeDocling({ statuses: ['pending', 'started', 'started', 'success'] });
  const out = await convertWithDocling(PDF, opts(d.fetchImpl));
  assert.deepEqual({ ok: out.ok, text: out.ok ? out.text : null }, { ok: true, text: 'Invoice INV-1 Total due: 10 EUR' });
  assert.equal(d.calls.filter((c) => c.url.includes('/v1/status/poll/')).length, 4);
});

test('UNREACHABLE: a refused connection is a typed parser-unreachable — no text', async () => {
  const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch;
  const out = await convertWithDocling(PDF, opts(fetchImpl));
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, 'parser-unreachable');
  assert.match(!out.ok ? out.reason : '', /Docling.*could not be reached.*ECONNREFUSED/);
  assert.equal('text' in out, false);
});

test('UNREACHABLE: a 404 on submit (a wrong route / wrong service) is parser-unreachable, not "empty document"', async () => {
  const d = fakeDocling({ submit: () => json({ detail: 'Not Found' }, 404) });
  const out = await convertWithDocling(PDF, opts(d.fetchImpl));
  assert.equal(!out.ok && out.code, 'parser-unreachable');
  assert.match(!out.ok ? out.reason : '', /HTTP 404/);
});

test('TIMEOUT: a conversion that never finishes stops at the deadline with parser-timeout', async () => {
  const d = fakeDocling({ statuses: ['started'] });
  let clock = 0;
  const out = await convertWithDocling(PDF, opts(d.fetchImpl, { timeoutMs: 5000, now: () => (clock += 1000) }));
  assert.equal(!out.ok && out.code, 'parser-timeout');
  assert.match(!out.ok ? out.reason : '', /did not finish within 5 s/);
  assert.equal(d.calls.some((c) => c.url.includes('/v1/result/')), false, 'no result is fetched for an unfinished task');
});

test('PARSER ERROR: a failed task and a failed document are parser-error with the parser’s words', async () => {
  const failedTask = fakeDocling({ statuses: ['failure'] });
  const a = await convertWithDocling(PDF, opts(failedTask.fetchImpl));
  assert.equal(!a.ok && a.code, 'parser-error');

  // What the live service answers for a corrupt PDF: HTTP 200, status failure, md_content null.
  const corrupt = fakeDocling({ result: { document: { filename: 'x.pdf', md_content: null }, status: 'failure', errors: [], processing_time: 0.003 } });
  const b = await convertWithDocling(PDF, opts(corrupt.fetchImpl));
  assert.equal(!b.ok && b.code, 'parser-error');
  assert.match(!b.ok ? b.reason : '', /corrupt or password-protected/);
});

test('NO TEXT: a successful conversion with nothing in it (a scan OCR read nothing from) is no-text', async () => {
  for (const md of ['', '   \n', '<!-- image -->\n\n<!-- image -->']) {
    const d = fakeDocling({ result: { document: { filename: 'scan.pdf', md_content: md }, status: 'success', errors: [] } });
    const out = await convertWithDocling(PDF, opts(d.fetchImpl));
    assert.equal(!out.ok && out.code, 'no-text', JSON.stringify(md));
  }
});

test('a task the parser forgot (restart) is a parser-error, not a hang', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(DOCLING_SUBMIT_PATH)) return json({ task_id: 't-9', task_status: 'pending' });
    return json({ detail: 'Task not found.' }, 404);
  }) as typeof fetch;
  const out = await convertWithDocling(PDF, opts(fetchImpl));
  assert.equal(!out.ok && out.code, 'parser-error');
});

test('doclingCanParse: binary documents only — text-like files, images and legacy Office are not sent', () => {
  for (const n of ['a.pdf', 'A.PDF', 'b.docx', 'c.pptx', 'd.xlsx', 'e.epub']) assert.equal(doclingCanParse(n), true, n);
  for (const n of ['a.txt', 'a.md', 'a.csv', 'a.json', 'p.png', 'v.mp4', 'old.doc', 'old.xls', 'z.zip']) assert.equal(doclingCanParse(n, 'application/pdf'), false, n);
  assert.equal(doclingCanParse('scan', 'application/pdf'), true, 'no extension ⇒ the stored content-type decides');
  assert.equal(doclingCanParse('blob', 'application/octet-stream'), false);
});

test('the API key goes out as X-Api-Key on submit, every poll and the result', async () => {
  const { fetchImpl, calls } = fakeDocling({ statuses: ['started', 'success'] });
  const out = await convertWithDocling(PDF, opts(fetchImpl, { apiKey: 'k-123' }));
  assert.equal(out.ok, true);
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.equal(c.headers[DOCLING_API_KEY_HEADER], 'k-123', c.url);
});

test('no API key configured → no X-Api-Key header at all', async () => {
  const { fetchImpl, calls } = fakeDocling({});
  await convertWithDocling(PDF, opts(fetchImpl));
  for (const c of calls) assert.equal(DOCLING_API_KEY_HEADER in c.headers, false, c.url);
});

test('the submit asks for TableFormer v2 (the Apache-2.0 table model baked into our image)', async () => {
  const { fetchImpl, calls } = fakeDocling({});
  await convertWithDocling(PDF, opts(fetchImpl));
  const form = calls.find((c) => c.url.endsWith(DOCLING_SUBMIT_PATH))!.form!;
  assert.equal(DOCLING_TABLE_STRUCTURE_PRESET, 'tableformer_v2');
  assert.equal(form.get('table_structure_preset'), 'tableformer_v2');
  assert.equal(form.get('do_table_structure'), 'true');
});

test('a 401 from a key-protected server is a typed parser-unreachable naming HTTP 401', async () => {
  const { fetchImpl } = fakeDocling({ submit: () => json({ detail: null }, 401) });
  const out = await convertWithDocling(PDF, opts(fetchImpl));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.code, 'parser-unreachable');
    assert.match(out.reason, /HTTP 401/);
  }
});
