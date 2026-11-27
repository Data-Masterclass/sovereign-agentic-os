/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       folders
 * FEATURE:    i18n wave 4 — folder refusals ("Folder not found", "Archive this folder before deleting it
 *             permanently", …) carry a code the UI renders in the person's language
 * USER STORY: As a user who picked Czech I want a refused folder move or delete explained in Czech, while API
 *             clients keep reading the same English. Proof: every coded FolderError and folder-route reply renders
 *             back to exactly its English from `server.<code>` in all seven catalogs.
 * ARCHITECTURE: scans the coded literal calls in the listed sources (no import of route modules), renders each
 *             code with `assertServerEnglish` (core/testing/server-message.ts); dynamic messages are table-tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorBody, errorBodyOf } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { FolderError } from '@core/folders/folder-store';

const ROOT = process.cwd();

function literalTriples(rel: string): { english: string; code: string }[] {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const lit = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const code = String.raw`'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)'`;
  const out: { english: string; code: string }[] = [];
  for (const re of [
    new RegExp(String.raw`new FolderError\(${lit}, \d+, ${code}\)`, 'g'),
    new RegExp(String.raw`apiError\(\d+, ${lit}, ${code}\)`, 'g'),
    new RegExp(String.raw`codedError\(\d+, ${lit}, ${code}\)`, 'g'),
  ]) {
    for (const m of src.matchAll(re)) out.push({ english: m[1].slice(1, -1).replace(/\\(.)/g, '$1'), code: m[2] });
  }
  return out;
}

test('every coded folder refusal renders its English in all locales', () => {
  let n = 0;
  for (const rel of ['core/folders/folder-store.ts', 'core/folders/folder-lifecycle.ts', 'app/api/folders/route.ts', 'app/api/folders/[id]/route.ts']) {
    const triples = literalTriples(rel);
    assert.ok(triples.length > 0, `${rel}: expected coded messages`);
    for (const { english, code } of triples) {
      assertServerEnglish(errorBody(english, code));
      n += 1;
    }
  }
  assert.ok(n >= 14, `scanned ${n} coded messages`);
});

test('a FolderError with a code reaches the envelope with status kept; without one it stays { error }', () => {
  const e = new FolderError('Folder not found', 404, 'folders.notFound');
  assert.equal(e.status, 404);
  assert.ok(e instanceof FolderError);
  assert.deepEqual(errorBodyOf(e), { error: 'Folder not found', code: 'folders.notFound' });
  assert.deepEqual(errorBodyOf(new FolderError('x', 400)), { error: 'x' });
});
