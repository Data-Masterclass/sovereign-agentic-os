/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for AST symbol extraction — the anti-forgery basis of the render check
 * USER STORY: As the reviewer of a build I want proof that "this file reaches governed data" is
 *             read from the parsed code, so a model cannot satisfy an acceptance check with a
 *             comment, a string, JSX text or a type-only import.
 * ARCHITECTURE: Pure unit tests over `symbols.ts` (parse-only TypeScript AST).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSymbols, importsModule, usedSymbols, usesSymbol } from './symbols.ts';

const REAL = [
  "import { createOsClient } from '@sovereign-os/app-sdk';",
  "import { Card } from '@sovereign-os/ui';",
  'const os = createOsClient();',
  "export const rows = async () => await os.datasets.query('ds_1');",
  'export const C = Card;',
].join('\n');

test('a real call and a real import are reported', () => {
  const s = fileSymbols('src/Page.tsx', REAL);
  assert.equal(s.note, undefined);
  assert.ok(s.imports.includes('@sovereign-os/app-sdk'));
  assert.ok(s.imports.includes('@sovereign-os/ui'));
  assert.ok(s.calls.includes('createOsClient'));
  assert.ok(s.calls.includes('os.datasets.query'), JSON.stringify(s.calls));
  assert.ok(usesSymbol(s, 'os.datasets'), 'a prefix of a called path counts');
  assert.ok(usesSymbol(s, 'os.datasets.query'));
  assert.ok(importsModule(s, '@sovereign-os/app-sdk'));
  assert.ok(!usesSymbol(s, 'os.records'), 'an unused surface must not count');
});

test('H2 a COMMENT naming the surface is invisible to the AST', () => {
  for (const src of [
    '// os.records.add({})',
    '/* os.records.add({}) */',
    '/**\n * os.records.add({})\n */\nexport const X = 1;',
  ]) {
    const s = fileSymbols('src/Page.tsx', src);
    assert.equal(usesSymbol(s, 'os.records'), false, src);
  }
});

test('H2 a STRING, a template literal and JSX TEXT naming the surface are invisible too', () => {
  for (const src of [
    "export const hint = 'os.records.add';",
    'export const hint = `call os.records.add here`;',
    'export const Doc = () => <p>os.records.add</p>;',
    "export const map = { 'os.records.add': true };",
  ]) {
    const s = fileSymbols('src/Page.tsx', src);
    assert.equal(usesSymbol(s, 'os.records'), false, src);
  }
});

test('H2 a TYPE-ONLY import does not count as using the SDK', () => {
  const s = fileSymbols('src/Page.tsx', "import type { QueryResult } from '@sovereign-os/app-sdk';\nexport type R = QueryResult;");
  assert.deepEqual(s.imports, []);
  assert.equal(importsModule(s, '@sovereign-os/app-sdk'), false);
  // A mixed import DOES count — the value half is real.
  const mixed = fileSymbols('src/P.tsx', "import { createOsClient, type QueryResult } from '@sovereign-os/app-sdk';\nexport const o = createOsClient();");
  assert.ok(importsModule(mixed, '@sovereign-os/app-sdk'));
});

test('await, parentheses and non-null assertions are unwrapped', () => {
  const s = fileSymbols('src/P.ts', 'export const r = async () => { await (os.records!).add({}); };');
  assert.ok(usesSymbol(s, 'os.records.add'), JSON.stringify(s));
});

test('a property READ counts (a destructured client still reaches the surface)', () => {
  const s = fileSymbols('src/P.ts', 'export const { query } = os.datasets;');
  assert.ok(usesSymbol(s, 'os.datasets'));
});

test('usedSymbols covers only TS/TSX files', () => {
  const all = usedSymbols([
    { path: 'src/a.tsx', content: REAL },
    { path: 'src/b.css', content: '.x { color: red }' },
    { path: 'index.html', content: '<p>os.records.add</p>' },
  ]);
  assert.deepEqual(all.map((f) => f.path), ['src/a.tsx']);
});

test('a syntactically broken file still parses — the compile gate is what rejects it', () => {
  const s = fileSymbols('src/P.tsx', 'export const x = (((;');
  assert.equal(s.note, undefined, 'the TS parser is error-tolerant; it does not throw');
  assert.equal(usesSymbol(s, 'os.records'), false);
});
