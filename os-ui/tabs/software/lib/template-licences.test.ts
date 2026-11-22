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
