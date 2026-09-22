/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUiSource, vendorUiForRepo, applyUiFileDep } from './app-ui-vendor.ts';

/** The file set the UI package MUST vendor — source files + generated package.json. */
const EXPECTED_FILES = [
  'theme.css',
  'cx.ts',
  'Button.tsx',
  'Card.tsx',
  'Badge.tsx',
  'Input.tsx',
  'Select.tsx',
  'Table.tsx',
  'Section.tsx',
  'Alert.tsx',
  'Spinner.tsx',
  'AppShell.tsx',
  'index.ts',
  'README.md',
  'package.json',
];

test('readUiSource returns the expected file set under the given prefix', () => {
  const files = readUiSource('vendor/@sovereign-os/ui');
  const names = files.map((f) => f.path.replace('vendor/@sovereign-os/ui/', ''));
  assert.deepEqual(new Set(names), new Set(EXPECTED_FILES));
  // Every file has non-empty content read from disk (no drift / no placeholders).
  for (const f of files) {
    assert.ok(f.content.length > 0, `${f.path} should have content`);
    assert.ok(f.path.startsWith('vendor/@sovereign-os/ui/'), `${f.path} under prefix`);
  }
});

test('readUiSource trims a trailing slash on the prefix', () => {
  const files = readUiSource('vendor/@sovereign-os/ui/');
  assert.ok(files.every((f) => !f.path.includes('//')), 'no double slashes in paths');
});

test('generated package.json names the package and exports the theme css', () => {
  const files = readUiSource('vendor/@sovereign-os/ui');
  const pkgFile = files.find((f) => f.path.endsWith('/package.json'));
  assert.ok(pkgFile, 'package.json present');
  const pkg = JSON.parse(pkgFile!.content) as Record<string, unknown>;
  assert.equal(pkg.name, '@sovereign-os/ui');
  assert.equal(pkg.main, 'index.ts');
  assert.deepEqual(pkg.exports, {
    '.': './index.ts',
    './theme.css': './theme.css',
  });
});

test('theme.css carries the OS brand tokens', () => {
  const files = readUiSource('x');
  const theme = files.find((f) => f.path.endsWith('/theme.css'));
  assert.ok(theme, 'theme.css present');
  assert.match(theme!.content, /--sb-gold:/);
  assert.match(theme!.content, /--sb-teal:/);
  assert.match(theme!.content, /\.sb-btn/);
  assert.match(theme!.content, /\.sb-shell/);
});

test('vendorUiForRepo places files under the repo vendor prefix', () => {
  const files = vendorUiForRepo();
  assert.ok(files.length === EXPECTED_FILES.length);
  assert.ok(files.every((f) => f.path.startsWith('vendor/@sovereign-os/ui/')));
});

test('applyUiFileDep rewrites the dependency to the vendored file: path', () => {
  const input = JSON.stringify({ dependencies: { '@sovereign-os/ui': '0.1.0', react: '19.0.0' } });
  const out = JSON.parse(applyUiFileDep(input)) as { dependencies: Record<string, string> };
  assert.equal(out.dependencies['@sovereign-os/ui'], 'file:./vendor/@sovereign-os/ui');
  assert.equal(out.dependencies.react, '19.0.0');
});

test('applyUiFileDep leaves input untouched when the dep is absent or unparseable', () => {
  const noDep = JSON.stringify({ dependencies: { react: '19.0.0' } });
  assert.equal(applyUiFileDep(noDep), noDep);
  assert.equal(applyUiFileDep('not json'), 'not json');
});

// --- README.md is docs, not code: optional in the shipped image -------------------

/** The CODE files (everything except README.md/package.json) — always required. */
const CODE_FILES = EXPECTED_FILES.filter((n) => n !== 'README.md' && n !== 'package.json');

function tempUiDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-ui-vendor-'));
  for (const name of names) writeFileSync(join(dir, name), `/* ${name} */\n`);
  return dir;
}

test('readUiSource succeeds WITHOUT README.md (the shipped image excludes markdown docs)', () => {
  const dir = tempUiDir(CODE_FILES); // all code, no README — the deployed-image layout
  try {
    const files = readUiSource('v', dir);
    const names = files.map((f) => f.path.replace('v/', ''));
    assert.ok(!names.includes('README.md'), 'the missing README is skipped, not fatal');
    assert.deepEqual(new Set(names), new Set([...CODE_FILES, 'package.json']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readUiSource still throws LOUDLY when a CODE file is missing (a real packaging break)', () => {
  const dir = tempUiDir(CODE_FILES.filter((n) => n !== 'AppShell.tsx'));
  try {
    assert.throws(() => readUiSource('v', dir), /ENOENT/, 'a missing code file must fail the vendor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
