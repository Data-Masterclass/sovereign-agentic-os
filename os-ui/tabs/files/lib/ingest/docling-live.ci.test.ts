/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Docling hop, proven against the REAL docling-serve image the chart ships
 * USER STORY: As the owner I need proof — not a mock — that the parser in my cluster is the pinned
 *             release, reads an invoice table with the Apache-2.0 TableFormer v2 model, refuses a
 *             caller without the key, and refuses a file above the size limit.
 * ARCHITECTURE:
 *   - Runs ONLY against a live container: `DOCLING_LIVE_URL` (e.g. http://127.0.0.1:5001) and
 *     `DOCLING_LIVE_API_KEY`, started from our derived image (`images/extensions/docling`) with
 *     the chart's env (limits, one worker, the key). `scripts/tests/docling-live.sh` does exactly
 *     that and is what the `docling-live` workflow runs.
 *   - In the ordinary unit run (`npm test`) the variables are unset and the suite SKIPS, saying
 *     so. With `DOCLING_LIVE_REQUIRED=1` (the workflow sets it) a missing URL is a FAILURE, so
 *     the live job can never pass by skipping.
 *   - The conversions go through `convertWithDocling` — the same client code the server runs.
 *   - (f) inspects the IMAGE itself (`DOCLING_LIVE_IMAGE`): the TableFormer v1 weights
 *     (`docling-project/docling-models`, CDLA-Permissive-2.0) must not be in it, and the v2
 *     weights (`docling-project/TableFormerV2`, Apache-2.0) must be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertWithDocling, DOCLING_SUBMIT_PATH } from '@tabs/files/lib/ingest/docling-client';

const URL_ = (process.env.DOCLING_LIVE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.DOCLING_LIVE_API_KEY ?? '';
const IMAGE = process.env.DOCLING_LIVE_IMAGE ?? '';
const REQUIRED = process.env.DOCLING_LIVE_REQUIRED === '1';
/** The release the chart pins; the live server must report exactly this. */
const PINNED_SERVE_VERSION = process.env.DOCLING_LIVE_EXPECT_VERSION ?? '1.38.2';
/** The chart's `DOCLING_SERVE_MAX_FILE_SIZE` (50 MiB). */
const MAX_FILE_SIZE = 52_428_800;

const skip = !URL_ && !REQUIRED ? 'DOCLING_LIVE_URL is not set (run scripts/tests/docling-live.sh)' : false;

const PDF = readFileSync(fileURLToPath(new URL('./fixtures/invoice-table.pdf', import.meta.url)));
const invoice = { name: 'invoice-table.pdf', bytes: PDF, contentType: 'application/pdf' };

test('live docling: the environment names a server', { skip }, () => {
  assert.ok(URL_, 'DOCLING_LIVE_URL must be set when DOCLING_LIVE_REQUIRED=1');
  assert.ok(KEY, 'DOCLING_LIVE_API_KEY must be set: the server must run with an API key');
});

test('live docling: GET /version reports the pinned docling-serve release', { skip }, async () => {
  const res = await fetch(`${URL_}/version`, { headers: { 'X-Api-Key': KEY } });
  assert.equal(res.status, 200, 'DOCLING_SERVE_SHOW_VERSION_INFO=true must expose /version');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['docling-serve'], PINNED_SERVE_VERSION, `version info: ${JSON.stringify(body)}`);
});

test('live docling (a): an invoice table comes back as markdown with its header row and every cell', { skip }, async () => {
  const out = await convertWithDocling(invoice, { baseUrl: URL_, apiKey: KEY, timeoutMs: 300_000 });
  assert.equal(out.ok, true, `conversion failed: ${JSON.stringify(out)}`);
  if (!out.ok) return;
  const rows = out.text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
  const header = rows.find((r) => cells(r)[0] === 'Item');
  assert.ok(header, `no markdown table header row in:\n${out.text}`);
  assert.deepEqual(cells(header!), ['Item', 'Quantity', 'Unit price (EUR)', 'Amount (EUR)']);
  const jacket = rows.find((r) => cells(r)[0] === 'Softshell jacket, women');
  assert.ok(jacket, `the line-item row is missing from the table:\n${out.text}`);
  assert.deepEqual(cells(jacket!), ['Softshell jacket, women', '260', '27.50', '7150.00']);
  assert.match(out.text, /AT-2026-119/);
  assert.match(out.text, /early payment discount/i, 'page 2 must be converted too');
});

test('live docling (a, negative twin): the v1 table model is not available to the server', { skip }, async () => {
  // A request that explicitly asks for TableFormer v1 must fail, because its weights are not in
  // the image. If this ever succeeds, the image is shipping the CDLA-licensed v1 weights again.
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(PDF)], { type: 'application/pdf' }), 'invoice-table.pdf');
  form.append('to_formats', 'md');
  form.append('table_structure_preset', 'tableformer_v1_accurate');
  const res = await fetch(`${URL_}/v1/convert/file`, { method: 'POST', body: form, headers: { 'X-Api-Key': KEY } });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const ok = res.status === 200 && body && (body.status === 'success' || body.status === 'partial_success');
  const md = String(((body?.document ?? {}) as Record<string, unknown>).md_content ?? '');
  assert.ok(!(ok && md.includes('| Softshell jacket, women')), `v1 produced a table: HTTP ${res.status} ${String(body?.status)}`);
});

test('live docling (e): a call without X-Api-Key is refused with 401, and the client says so', { skip }, async () => {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(PDF)], { type: 'application/pdf' }), 'invoice-table.pdf');
  const raw = await fetch(`${URL_}${DOCLING_SUBMIT_PATH}`, { method: 'POST', body: form });
  assert.equal(raw.status, 401);
  const out = await convertWithDocling(invoice, { baseUrl: URL_, timeoutMs: 30_000 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, 'parser-unreachable');
  assert.match(out.reason, /HTTP 401/);
  const wrong = await convertWithDocling(invoice, { baseUrl: URL_, apiKey: `${KEY}-wrong`, timeoutMs: 30_000 });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.match(wrong.reason, /HTTP 401/);
});

test('live docling: a file above DOCLING_SERVE_MAX_FILE_SIZE is refused, never converted', { skip }, async (t) => {
  // The real fixture, padded past 50 MiB after %%EOF (a reader ignores trailing bytes), so the
  // ONLY reason to refuse it is its size.
  const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_SIZE + 1024 * 1024 - PDF.length, 0x0a)]);
  const out = await convertWithDocling({ ...invoice, bytes: big }, { baseUrl: URL_, apiKey: KEY, timeoutMs: 300_000 });
  assert.equal(out.ok, false, 'a 51 MiB file must not convert');
  if (out.ok) return;
  t.diagnostic(`refusal: ${out.code} — ${out.reason}`);
  assert.equal(out.code, 'parser-error', JSON.stringify(out));
  // Docling's own refusal text must name the size limit (not some unrelated failure).
  assert.match(out.reason, /size|limit|large|exceed/i, out.reason);
  // Positive twin: the SAME padding just below the limit converts, so the size alone decided.
  const under = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_SIZE - 1024 * 1024 - PDF.length, 0x0a)]);
  const ok = await convertWithDocling({ ...invoice, bytes: under }, { baseUrl: URL_, apiKey: KEY, timeoutMs: 300_000 });
  assert.equal(ok.ok, true, `49 MiB with the same padding must convert: ${JSON.stringify(ok)}`);
});

test('live docling (f): the image carries TableFormer v2 and no TableFormer v1 weights', { skip }, () => {
  assert.ok(IMAGE, 'DOCLING_LIVE_IMAGE must name the image under test');
  const listing = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'ls -1 "$DOCLING_SERVE_ARTIFACTS_PATH"'],
    { encoding: 'utf8' },
  );
  const dirs = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(!dirs.includes('docling-project--docling-models'), `v1 weights present: ${dirs.join(', ')}`);
  assert.ok(dirs.includes('docling-project--TableFormerV2'), `v2 weights missing: ${dirs.join(', ')}`);
});
