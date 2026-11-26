/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    Fixture tests for scripts/check-i18n.mjs — parity, ICU, layout and the hard-coded-text ratchet
 * USER STORY: As a maintainer I want proof that the i18n guard fails on each thing it promises to catch, and stays
 *             quiet on numbers, punctuation, brand names and translated code — so it is trusted, not bypassed.
 * ARCHITECTURE:
 *   - Each test writes a throwaway tree (mkdtemp) and runs the checker on it with `--root`. TypeScript and the ICU
 *     parser are resolved from this repo's os-ui/node_modules (the checker falls back to them).
 *   - Run: node --test scripts/tests/check-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-i18n.mjs');
const LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'];
const NAMESPACES = ['shell', 'common', 'settings', 'server', 'admin', 'agents', 'connections', 'dashboards', 'data', 'files', 'governance', 'home', 'knowledge', 'metrics', 'monitoring', 'software', 'workflows'];

/** A valid tree: every namespace empty except `shell`, which carries `shell` per locale. */
function tree({ shell = {}, files = {}, converted = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'i18n-'));
  for (const l of LOCALES) {
    mkdirSync(join(root, 'os-ui', 'messages', l), { recursive: true });
    for (const n of NAMESPACES) {
      const body = n === 'shell' ? (shell[l] ?? shell.en ?? {}) : {};
      writeFileSync(join(root, 'os-ui', 'messages', l, `${n}.json`), JSON.stringify(body));
    }
  }
  for (const [p, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), src);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'i18n-converted.json'), JSON.stringify(converted));
  return root;
}
function run(root) {
  const r = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const all = (msg) => Object.fromEntries(LOCALES.map((l) => [l, msg]));

test('a tree in parity passes', () => {
  const r = run(tree({ shell: all({ nav: { home: 'Home', count: '{n, plural, one {# item} other {# items}}' } }) }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check-i18n: ok/);
});

test('PARITY: a missing key, an extra key and an empty string each fail', () => {
  const r = run(tree({ shell: { ...all({ a: 'A', b: 'B' }), de: { a: 'A' }, fr: { a: 'A', b: 'B', c: 'C' }, it: { a: 'A', b: ' ' } } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /de\/shell\.json b — missing/);
  assert.match(r.out, /fr\/shell\.json c — extra key/);
  assert.match(r.out, /it\/shell\.json b — empty string/);
});

test('PARITY: a renamed or dropped placeholder fails; different plural categories are fine', () => {
  const r = run(tree({ shell: {
    ...all({ x: 'Hi {name}', p: '{n, plural, one {# file} other {# files}}' }),
    de: { x: 'Hallo {nom}', p: '{n, plural, one {# Datei} other {# Dateien}}' },
    pl: { x: 'Cześć {name}', p: '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}' },
    cs: { x: 'Ahoj', p: '{n, plural, one {# soubor} few {# soubory} other {# souborů}}' },
  } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /de\/shell\.json x — placeholders differ/);
  assert.match(r.out, /cs\/shell\.json x — placeholders differ/);
  assert.doesNotMatch(r.out, /pl\/shell\.json/);
});

test('PARITY: ICU that does not parse, an unbalanced tag and a plural without other all fail', () => {
  const r = run(tree({ shell: { ...all({ a: 'ok {x}', b: 'see <link>this</link>', c: '{n, plural, other {#}}' }), de: { a: 'kaputt {x', b: 'siehe <link>das', c: '{n, plural, one {#}}' } } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /de\/shell\.json a — ICU does not parse/);
  assert.match(r.out, /de\/shell\.json b — ICU does not parse/);
  assert.match(r.out, /de\/shell\.json c — plural "n" has no "other" branch/);
});

test('LAYOUT: an unknown namespace file or a missing locale folder fails', () => {
  const root = tree();
  writeFileSync(join(root, 'os-ui', 'messages', 'de', 'misc.json'), '{}');
  rmSync(join(root, 'os-ui', 'messages', 'cs'), { recursive: true });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /I18N-LAYOUT\s+os-ui\/messages\/de\/misc\.json/);
  assert.match(r.out, /I18N-LAYOUT\s+os-ui\/messages\/cs — missing locale folder/);
});

const BAD = `export function X({ on, n }: { on: boolean; n: number }) {
  return (
    <div aria-label="Main menu" title={'Close it'}>
      Save changes
      {'Domain: '}
      {on ? 'ON' : 'OFF'}
      <input placeholder={\`Search \${n} items\`} />
      <img alt="A picture" />
    </div>
  );
}
`;
const GOOD = `export function Y({ t, n }: { t: (k: string) => string; n: number }) {
  return (
    <div aria-label={t('menu')} title={t('close')} className="btn primary" data-x="raw words are fine here">
      {t('save')} {n} · 12% — ✓ ×
      <img alt="Sovereign Agentic OS" />
      <span>Sovereign <b>Agentic</b> OS</span> <em>Data Masterclass</em> MCP
      {/* i18n-ignore — a deliberate exception */}
      Deliberately English
    </div>
  );
}
`;

test('RATCHET: every kind of hard-coded text in a converted file fails, with its line', () => {
  const r = run(tree({ files: { 'os-ui/core/ui/X.tsx': BAD }, converted: { shell: ['os-ui/core/ui/X.tsx'] } }));
  assert.equal(r.code, 1);
  for (const s of ['aria-label= "Main menu"', 'title= "Close it"', 'JSX text "Save changes"', 'string in JSX "Domain:', 'string in JSX "ON"', 'string in JSX "OFF"', 'placeholder= "Search', 'alt= "A picture"']) {
    assert.ok(r.out.includes(s), `expected ${s} in:\n${r.out}`);
  }
  assert.match(r.out, /X\.tsx:3 /);
});

test('RATCHET: translated code, numbers, symbols, brand names, other attributes and i18n-ignore pass', () => {
  const r = run(tree({ files: { 'os-ui/core/ui/Y.tsx': GOOD }, converted: { shell: ['os-ui/core/ui/Y.tsx'] } }));
  assert.equal(r.code, 0, r.out);
});

test('RATCHET: only converted paths are checked; a folder entry covers its files; a stale entry or unknown key fails', () => {
  const ok = run(tree({ files: { 'os-ui/tabs/data/ui/A.tsx': BAD } }));
  assert.equal(ok.code, 0, 'an unconverted file is not checked yet');
  const dir = run(tree({ files: { 'os-ui/tabs/data/ui/A.tsx': BAD }, converted: { data: ['os-ui/tabs/data/ui'] } }));
  assert.equal(dir.code, 1);
  assert.match(dir.out, /tabs\/data\/ui\/A\.tsx/);
  const stale = run(tree({ converted: { data: ['os-ui/tabs/data/ui/Gone.tsx'], nope: [] } }));
  assert.equal(stale.code, 1);
  assert.match(stale.out, /Gone\.tsx does not exist/);
  assert.match(stale.out, /"nope" is not a namespace/);
});
