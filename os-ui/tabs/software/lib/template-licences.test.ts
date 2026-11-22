/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the template ships no LGPL code (sharp / libvips)
 * USER STORY: As the owner I want every app built from the golden path to be free of copyleft image
 *             libraries, so the licence of what ships is Apache-2.0, MIT, BSD or ISC (plus the named
 *             exceptions the owner decides on).
 * ARCHITECTURE: reads templates/nextjs-web/package-lock.json and next.config.mjs. `copyleftIn` is the
 *             detector; the negative twin feeds it a lock that still has sharp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), '..');
const lockOf = () => JSON.parse(readFileSync(join(ROOT, 'templates/nextjs-web/package-lock.json'), 'utf8')) as { packages: Record<string, { license?: string }> };

export function copyleftIn(lock: { packages: Record<string, { license?: string }> }): string[] {
  return Object.entries(lock.packages)
    .filter(([k, v]) => /(^|\/)(sharp|@img\/[^/]+)$/.test(k) || /LGPL|GPL/.test(String(v.license ?? '')))
    .map(([k]) => k);
}

test('the template lockfile has no sharp, no @img/*, and nothing LGPL/GPL', () => {
  assert.deepEqual(copyleftIn(lockOf()), []);
});

test('NEGATIVE TWIN: the detector does flag a lock that still carries sharp', () => {
  assert.ok(copyleftIn({ packages: { 'node_modules/sharp': {}, 'node_modules/@img/sharp-libvips-linux-x64': { license: 'LGPL-3.0-or-later' } } }).length >= 2);
});

test('Next.js is told not to optimise images, so nothing needs sharp at build or run time', () => {
  assert.match(readFileSync(join(ROOT, 'templates/nextjs-web/next.config.mjs'), 'utf8'), /images:\s*\{\s*unoptimized:\s*true\s*\}/);
});

// Owner licence decision: permissive licences with attribution are allowed (Apache-2.0, MIT, BSD, ISC, 0BSD, Zlib,
// Unlicense, BlueOak, PSF/Python-2.0, CC-BY-4.0, CC0); copyleft and source-available are not. Every package under a
// licence that is not Apache/MIT/BSD/ISC must be named, with its licence and role, in the template's NOTICE file.
const PLAIN = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|MIT-0|Unlicense|BlueOak-1\.0\.0|\(MIT OR [^)]*\)|\(BSD-2-Clause OR [^)]*\))$/;
export function needsAttribution(lock: { packages: Record<string, { license?: string }> }): { name: string; license: string }[] {
  return Object.entries(lock.packages)
    .filter(([k, v]) => k && v.license && !PLAIN.test(v.license))
    .map(([k, v]) => ({ name: k.replace(/^.*node_modules\//, ''), license: String(v.license) }));
}

test('every package under a non-Apache/MIT/BSD/ISC licence is attributed in templates/nextjs-web/NOTICE', () => {
  const notice = readFileSync(join(ROOT, 'templates/nextjs-web/NOTICE'), 'utf8');
  const need = needsAttribution(lockOf());
  assert.ok(need.length > 0, 'the lock still has caniuse-lite and argparse; this list must not be empty');
  for (const { name, license } of need) {
    assert.ok(notice.includes(name), `${name} is missing from NOTICE`);
    assert.ok(notice.includes(license), `${name}: licence ${license} is missing from NOTICE`);
  }
});

test('NEGATIVE TWIN: the detector flags an unlisted CC-BY package, and nothing forbidden is allowed', () => {
  assert.deepEqual(needsAttribution({ packages: { 'node_modules/x': { license: 'CC-BY-4.0' }, 'node_modules/y': { license: 'MIT' } } }), [{ name: 'x', license: 'CC-BY-4.0' }]);
  assert.ok(copyleftIn({ packages: { 'node_modules/z': { license: 'MPL-2.0' } } }).length === 0, 'MPL is caught by the CI licence gate, not this detector');
});

// Every attribution entry (a block starting at an unindented line) must carry its licence and a copyright line.
function noticeBlocks(notice: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let name = '';
  for (const line of notice.split('\n')) {
    if (/^\S/.test(line) && !/^(Third-party|The template|The packages|Regenerate)/.test(line) && line.trim()) { name = line.trim(); blocks.set(name, ''); }
    else if (name) blocks.set(name, `${blocks.get(name)}${line}\n`);
  }
  return blocks;
}
/** Packages the lock holds under any licence other than Apache/MIT/BSD/ISC, INCLUDING packages that declare none. */
export function attributionNeeded(lock: { packages: Record<string, { license?: string }> }): { name: string; license: string }[] {
  return Object.entries(lock.packages)
    .filter(([k, v]) => k && !(v.license && PLAIN.test(v.license)))
    .map(([k, v]) => ({ name: k.replace(/^.*node_modules\//, ''), license: v.license ? String(v.license) : '' }));
}
export function noticeGaps(lock: { packages: Record<string, { license?: string }> }, notice: string): string[] {
  const blocks = noticeBlocks(notice);
  const gaps: string[] = [];
  for (const { name, license } of attributionNeeded(lock)) {
    const b = blocks.get(name);
    if (b === undefined) { gaps.push(`${name}: not named in NOTICE`); continue; }
    if (license && !b.includes(license)) gaps.push(`${name}: licence ${license} missing`);
    if (!/Licence:\s*\S/.test(b)) gaps.push(`${name}: no Licence line`);
    if (!/Copyright:\s*\S/.test(b)) gaps.push(`${name}: no Copyright line`);
  }
  return gaps;
}

test('NOTICE names every non-Apache/MIT/BSD/ISC package of the lock (argparse, caniuse-lite, the SDK) with licence and copyright', () => {
  const notice = readFileSync(join(ROOT, 'templates/nextjs-web/NOTICE'), 'utf8');
  assert.deepEqual(noticeGaps(lockOf(), notice), []);
  const names = attributionNeeded(lockOf()).map((n) => n.name).sort();
  assert.ok(names.includes('argparse') && names.includes('caniuse-lite'), names.join(','));
  assert.match(notice, /argparse[\s\S]*Python-2\.0/);
  assert.match(notice, /caniuse-lite[\s\S]*CC-BY-4\.0/);
});

test('NEGATIVE TWINS: a package missing from NOTICE, one without a copyright line, and one with no declared licence are all flagged', () => {
  const lock = { packages: { '': {}, 'node_modules/argparse': { license: 'Python-2.0' }, 'node_modules/new-thing': { license: 'CC-BY-4.0' }, 'node_modules/nolic': {}, 'node_modules/ok': { license: 'MIT' } } };
  const notice = 'argparse\n  Licence: Python-2.0\n\nnolic\n  Licence: Apache-2.0\n  Copyright: someone\n';
  assert.deepEqual(noticeGaps(lock, notice), ['argparse: no Copyright line', 'new-thing: not named in NOTICE']);
  assert.deepEqual(noticeGaps(lock, `${notice}new-thing\n  Licence: CC-BY-4.0\n  Copyright: x\n`), ['argparse: no Copyright line']);
});
