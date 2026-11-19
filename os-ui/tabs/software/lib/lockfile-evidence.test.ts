/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    Lockfile evidence — agreement between an npm manifest and its lockfile
 * USER STORY: As a Builder I need a changed `package.json` to stop counting as "dependencies
 *             scanned" until its lockfile is regenerated.
 * ARCHITECTURE: Pure unit tests over `lockfile-evidence.ts`. Each case is a tree a user can really
 *             produce through `push_app_files` or the editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareManifestToLock, compareManifestToLockEntry, npmLockEvidence } from './lockfile-evidence.ts';

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

const MANIFEST = {
  name: 'shop',
  version: '1.2.0',
  dependencies: { clsx: '^2.1.1' },
  devDependencies: { vite: '^5.4.2' },
};
const LOCK = {
  name: 'shop',
  version: '1.2.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'shop', version: '1.2.0', dependencies: { clsx: '^2.1.1' }, devDependencies: { vite: '^5.4.2' } },
    'node_modules/clsx': { version: '2.1.1' },
    'node_modules/vite': { version: '5.4.21', dev: true },
  },
};

test('a lockfile written for exactly this manifest has no differences', () => {
  assert.deepEqual(compareManifestToLock(MANIFEST, LOCK), []);
});

test('a bumped range, an added dependency and a removed one are each named', () => {
  const bumped = compareManifestToLock({ ...MANIFEST, dependencies: { clsx: '^3.0.0' } }, LOCK);
  assert.equal(bumped.length, 1);
  assert.match(bumped[0], /"clsx" is \^3\.0\.0 in package\.json but \^2\.1\.1 in the lockfile/);

  const added = compareManifestToLock({ ...MANIFEST, dependencies: { clsx: '^2.1.1', lodash: '4.17.20' } }, LOCK);
  assert.ok(added.some((p) => /"lodash" \(4\.17\.20\) is declared but absent from the lockfile/.test(p)), added.join('\n'));

  const removed = compareManifestToLock({ ...MANIFEST, devDependencies: {} }, LOCK);
  assert.ok(removed.some((p) => /"vite" is in the lockfile but no longer declared/.test(p)), removed.join('\n'));
});

test('name and version are part of the agreement', () => {
  assert.match(compareManifestToLock({ ...MANIFEST, name: 'other' }, LOCK).join('\n'), /name: package\.json says "other"/);
  assert.match(compareManifestToLock({ ...MANIFEST, version: '2.0.0' }, LOCK).join('\n'), /version: package\.json says 2\.0\.0/);
});

test('a root entry edited to match by hand, with nothing RESOLVED, is not agreement', () => {
  // The cheap forgery: copy the new range into `packages[""]` and stop. No install ran.
  const forged = {
    ...LOCK,
    packages: {
      ...LOCK.packages,
      '': { ...LOCK.packages[''], dependencies: { clsx: '^2.1.1', lodash: '4.17.20' } },
    },
  };
  const problems = compareManifestToLock({ ...MANIFEST, dependencies: { clsx: '^2.1.1', lodash: '4.17.20' } }, forged);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"lodash" is declared but the lockfile holds no resolution for it/);
});

test('something that is not a v2/v3 lockfile is never "consistent"', () => {
  assert.match(compareManifestToLock(MANIFEST, { lockfileVersion: 3 }).join('\n'), /no `packages` table/);
  assert.match(compareManifestToLock(MANIFEST, { lockfileVersion: 3, packages: {} }).join('\n'), /no root package entry/);
});

test('a local package is compared with the entry the ancestor lockfile holds for it', () => {
  const entry = { version: '0.1.0', peerDependencies: { react: '>=18' } };
  assert.deepEqual(compareManifestToLockEntry({ name: '@x/ui', version: '0.1.0', peerDependencies: { react: '>=18' } }, entry), []);
  assert.match(
    compareManifestToLockEntry({ name: '@x/ui', version: '0.2.0', peerDependencies: { react: '>=18' } }, entry).join('\n'),
    /version: package\.json says 0\.2\.0 but the lockfile says 0\.1\.0/,
  );
  assert.match(
    compareManifestToLockEntry({ name: '@x/ui', version: '0.1.0', dependencies: { clsx: '^2' } }, entry).join('\n'),
    /"clsx" \(\^2\) is declared but absent/,
  );
});

// --------------------------------------------------------------- whole trees --------

test('tree: a consistent root lock covers the root manifest', () => {
  const ev = npmLockEvidence([
    { path: 'package.json', content: json(MANIFEST) },
    { path: 'package-lock.json', content: json(LOCK) },
  ]);
  assert.deepEqual(ev, [
    { manifest: 'package.json', declared: 2, lock: 'package-lock.json', state: 'consistent', resolved: 2, problems: [] },
  ]);
});

test('tree: a manifest pushed without a new lock is STALE, with the difference named', () => {
  const ev = npmLockEvidence([
    { path: 'package.json', content: json({ ...MANIFEST, dependencies: { clsx: '^2.1.1', 'left-pad': '1.3.0' } }) },
    { path: 'package-lock.json', content: json(LOCK) },
  ]);
  assert.equal(ev[0].state, 'stale');
  assert.match(ev[0].problems.join('\n'), /left-pad/);
});

test('tree: no lockfile at all is UNLOCKED; a yarn/pnpm lock beside it is OTHER-LOCK (not parsed here)', () => {
  assert.equal(npmLockEvidence([{ path: 'package.json', content: json(MANIFEST) }])[0].state, 'unlocked');
  const yarn = npmLockEvidence([
    { path: 'package.json', content: json(MANIFEST) },
    { path: 'yarn.lock', content: '# yarn lockfile v1\n' },
  ]);
  assert.equal(yarn[0].state, 'other-lock');
});

test('tree: an unparseable manifest or lockfile is UNREADABLE, never consistent', () => {
  const badLock = npmLockEvidence([
    { path: 'package.json', content: json(MANIFEST) },
    { path: 'package-lock.json', content: '{not json' },
  ]);
  assert.equal(badLock[0].state, 'unreadable');
  const badManifest = npmLockEvidence([
    { path: 'package.json', content: '{not json' },
    { path: 'package-lock.json', content: json(LOCK) },
  ]);
  assert.equal(badManifest[0].state, 'unreadable');
});

test('tree: an npm v1 lockfile has no root entry to compare and is left to the engine (OTHER-LOCK)', () => {
  const ev = npmLockEvidence([
    { path: 'package.json', content: json(MANIFEST) },
    { path: 'package-lock.json', content: json({ lockfileVersion: 1, dependencies: { clsx: { version: '2.1.1' } } }) },
  ]);
  assert.equal(ev[0].state, 'other-lock');
});

test('tree: a vendored local package is covered by the ROOT lock, and drifts with its own manifest', () => {
  const rootManifest = { name: 'app', version: '0.0.0', dependencies: { '@x/ui': 'file:./vendor/@x/ui' } };
  const lock = {
    name: 'app',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '0.0.0', dependencies: { '@x/ui': 'file:./vendor/@x/ui' } },
      'node_modules/@x/ui': { resolved: 'vendor/@x/ui', link: true },
      'vendor/@x/ui': { version: '0.1.0', peerDependencies: { react: '>=18' } },
    },
  };
  const tree = (uiVersion: string) => [
    { path: 'package.json', content: json(rootManifest) },
    { path: 'package-lock.json', content: json(lock) },
    { path: 'vendor/@x/ui/package.json', content: json({ name: '@x/ui', version: uiVersion, peerDependencies: { react: '>=18' } }) },
  ];
  const ok = npmLockEvidence(tree('0.1.0'));
  assert.deepEqual(ok.map((e) => [e.manifest, e.state, e.lock]), [
    ['package.json', 'consistent', 'package-lock.json'],
    ['vendor/@x/ui/package.json', 'consistent', 'package-lock.json'],
  ]);
  const drifted = npmLockEvidence(tree('0.2.0'));
  assert.equal(drifted[1].state, 'stale');
});

test('tree: a nested manifest with its own lock is judged against ITS lock, not the root one', () => {
  const ev = npmLockEvidence([
    { path: 'package.json', content: json(MANIFEST) },
    { path: 'package-lock.json', content: json(LOCK) },
    { path: 'functions/package.json', content: json({ name: 'fn', dependencies: { ms: '^2.1.3' } }) },
  ]);
  assert.deepEqual(ev.map((e) => [e.manifest, e.state]), [
    ['package.json', 'consistent'],
    ['functions/package.json', 'unlocked'],
  ]);
});

test('tree: anything under node_modules is ignored', () => {
  const ev = npmLockEvidence([
    { path: 'node_modules/x/package.json', content: json({ name: 'x', dependencies: { y: '1' } }) },
    { path: 'node_modules/x/package-lock.json', content: json(LOCK) },
  ]);
  assert.deepEqual(ev, []);
});
