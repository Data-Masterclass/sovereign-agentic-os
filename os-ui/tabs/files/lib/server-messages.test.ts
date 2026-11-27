/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       files
 * FEATURE:    i18n wave 4 — the Files tab's and the upload doors' person-facing server messages carry a code
 * USER STORY: As a user who picked German I want "File not found", "file exceeds the 200 MB upload limit" or a
 *             refused chat attachment in German, while API and MCP clients keep reading the same English.
 *             Proof: every (English, code, params) the files routes, the files store and the upload doors emit
 *             renders back to exactly that English from `server.<code>` and exists in all seven catalogs.
 * ARCHITECTURE: scans the coded literal calls in the listed sources (no import of route modules), renders each
 *             code with `assertServerEnglish` (core/testing/server-message.ts); dynamic messages are table-tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorBody, errorBodyOf } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { truncationErrorBody } from '@tabs/files/lib/integrity';
import { uploadCreateRefusalBody } from '@core/infra/governed';
import { sniffAttachment } from '@core/runtime/chat-attachments';
import { AssetError } from '@tabs/files/lib/asset-schema';

const ROOT = process.cwd();

/** Every literal-English coded call in a source file: apiError / codedError / fail / refuse with a quoted string. */
function literalTriples(rel: string): { english: string; code: string }[] {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const out: { english: string; code: string }[] = [];
  const lit = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const code = String.raw`'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)'`;
  const patterns = [
    new RegExp(String.raw`apiError\(\d+, ${lit}, ${code}\)`, 'g'),
    new RegExp(String.raw`codedError\([^,]+, ${lit}, ${code}\)`, 'g'),
    new RegExp(String.raw`fail\(${lit}, \d+, ${code}\)`, 'g'),
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push({ english: m[1].slice(1, -1).replace(/\\(.)/g, '$1'), code: m[2] });
  }
  return out;
}

const SOURCES = [
  'tabs/files/lib/store.ts',
  'tabs/files/lib/describe.ts',
  'tabs/files/lib/object-store.ts',
  'app/api/files/route.ts',
  'app/api/files/[id]/route.ts',
  'app/api/files/[id]/raw/route.ts',
  'app/api/files/[id]/folder/route.ts',
  'app/api/files/[id]/versions/route.ts',
  'app/api/files/[id]/use-as/route.ts',
  'app/api/files/connectors/route.ts',
  'app/api/files/connectors/[id]/route.ts',
  'app/api/files/retrieve/route.ts',
  'app/api/assistant/attachments/route.ts',
];

test('every literal coded message in the files routes, store and upload doors renders its English in all locales', () => {
  let n = 0;
  for (const rel of SOURCES) {
    const triples = literalTriples(rel);
    assert.ok(triples.length > 0, `${rel}: expected coded messages`);
    for (const { english, code } of triples) {
      assertServerEnglish(errorBody(english, code));
      n += 1;
    }
  }
  assert.ok(n >= 30, `scanned ${n} coded messages`);
});

test('dynamic files-store refusals keep their English', () => {
  const table: [string, string, Record<string, string | number>][] = [
    ['Version 3 not found', 'files.versionNotFound', { version: 3 }],
    ['Version 3 has no restorable source', 'files.versionNotRestorable', { version: 3 }],
    ['Choose one of your own Google Drive connections', 'files.sourceChooseOwn', { provider: 'Google Drive' }],
    ['You have 2 OneDrive connections — choose which one this source uses', 'files.sourceChooseOne', { count: 2, provider: 'OneDrive' }],
    ["Connect your OneDrive in Connections first — a source syncs with that connection's sign-in", 'files.sourceConnectFirst', { provider: 'OneDrive' }],
    ['file exceeds the 200 MB upload limit', 'upload.tooLarge', { maxMb: 200 }],
    ['These files together exceed the 200 MB a message can carry. Nothing was uploaded.', 'upload.attachTotalTooLarge', { maxMb: 200 }],
    ['A message can carry at most 5 files (this one had 7). Nothing was uploaded.', 'upload.attachTooMany', { max: 5, count: 7 }],
    ['It is larger than the 50 MB Files accepts.', 'upload.attachTooLargeFor', { size: '50 MB', destination: 'files' }],
    ['It is larger than the 512 KB Knowledge accepts.', 'upload.attachTooLargeFor', { size: '512 KB', destination: 'knowledge' }],
    ['Policy did not allow creating a dataset in your My scope. Nothing was written.', 'upload.attachPolicyDenied', { destination: 'data' }],
    ['The policy engine did not answer, so creating a knowledge note was not allowed (it never fails open). Nothing was written; try again shortly.', 'upload.attachPolicyUnreachable', { destination: 'knowledge' }],
  ];
  for (const [english, code, params] of table) assertServerEnglish(errorBody(english, code, params));
  assertServerEnglish(errorBody('It is not UTF-8 text throughout, so it cannot be saved as a knowledge note. Save it as UTF-8, or send it to Files.', 'upload.attachNoteNotUtf8'));
});

test('a coded AssetError reaches the envelope; an uncoded one stays exactly { error }', async () => {
  const { withServerCode } = await import('@core/kernel/server-message');
  const e = withServerCode(new AssetError('File not found', 404), 'files.notFound');
  assert.deepEqual(errorBodyOf(e), { error: 'File not found', code: 'files.notFound' });
  assert.deepEqual(errorBodyOf(new AssetError('x', 400)), { error: 'x' });
});

test('the truncation guard and the upload refusals carry codes with unchanged English', () => {
  const body = truncationErrorBody(10_000_000, '50000000')!;
  assert.equal(body.error, 'upload incomplete — received 10000000 of 50000000 bytes; please retry');
  assertServerEnglish(body);
  assert.equal(truncationErrorBody(5, '5'), null);
  for (const kind of ['file', 'dataset', 'knowledge'] as const) assertServerEnglish(uploadCreateRefusalBody(kind));
});

test('every attachment sniff refusal carries a code that renders its exact English', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const cases: [string, Uint8Array][] = [
    ['empty.csv', new Uint8Array(0)],
    ['a.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])],
    ['old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['latin.csv', new Uint8Array([0x61, 0xe9, 0x62, 0x0a])],
    ['blob.bin', new Uint8Array([0, 1, 2, 3, 0, 255])],
    ['noext', new Uint8Array([0, 1, 2, 3, 0, 255])],
    ['x.json', enc('hello')],
    ['x.ndjson', enc('not json\n')],
    ['page.txt', enc('<html><body>x</body></html>')],
    ['x.exe', enc('hello world')],
  ];
  const seen = new Set<string>();
  for (const [name, bytes] of cases) {
    const s = sniffAttachment(name, bytes);
    assert.equal(s.ok, false, name);
    if (s.ok) continue;
    assert.ok(s.code, `${name}: refusal has a code`);
    assertServerEnglish({ error: s.reason, code: s.code, params: s.params });
    seen.add(s.code!);
  }
  assert.ok(seen.size >= 9, `covered ${[...seen].join(', ')}`);
});
