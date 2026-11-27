#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Regenerate the real npm lockfile a golden-path template ships.
 * USER STORY: As a maintainer who changed a template's dependencies I want one command that re-resolves
 *             its lockfile with npm itself, so the dependency scan describes what an app really declares.
 * ARCHITECTURE: Writes the manifests an instantiated app commits (package.json, the vendored SDK's
 *             package.json, the scope-pin .npmrc) into an empty temp dir, runs
 *             `npm install --package-lock-only --ignore-scripts` there and copies npm's own output
 *             (minus sharp, see strip-lock-sharp.mjs) to templates/<dir>/package-lock.json under the placeholder name. Needs network.
 *             A template that ships a platform-owned `migrate/package.json` (nextjs-web@2, App Builder D) gets
 *             `migrate/package-lock.json` resolved the same way, from that manifest alone.
 *               cd os-ui && node --experimental-strip-types --import ./scripts/test-setup.mjs scripts/regen-golden-path-lock.mjs [nextjs-web|nextjs-web@2]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
process.env.GOLDEN_PATH_TEMPLATES_DIR = join(ROOT, '..', 'templates');
const ref = process.argv[2] ?? 'nextjs-web';
const { goldenPathFiles, LOCK_PLACEHOLDER, parseTemplateRef, templateDirOf } = await import('../tabs/software/lib/golden-path.ts');
const parsed = parseTemplateRef(ref);
if (!parsed) {
  console.error(`regen-golden-path-lock: unknown template ${ref}`);
  process.exit(2);
}
const { key, version } = parsed;
const out = templateDirOf(key, version);
const { stripSharp } = await import('./strip-lock-sharp.mjs');

/** `npm install --package-lock-only` in `dir`; npm's own lockfile, minus sharp. */
function resolveLock(dir) {
  const run = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`regen-golden-path-lock: npm failed:\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
  }
  // npm always resolves Next's optional `sharp` (LGPL libvips); the template does not use it, so it is removed.
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  stripSharp(lock);
  return `${JSON.stringify(lock, null, 2)}\n`;
}

const files = goldenPathFiles(key, { name: 'App', slug: LOCK_PLACEHOLDER }, version);
const dir = mkdtempSync(join(tmpdir(), `golden-path-lock-${out}-`));
try {
  for (const f of files) {
    if (f.path.startsWith('migrate/')) continue;
    if (!/(^|\/)(package\.json|\.npmrc)$/.test(f.path)) continue;
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  writeFileSync(join(ROOT, '..', 'templates', out, 'package-lock.json'), resolveLock(dir));
  console.log(`regen-golden-path-lock: wrote templates/${out}/package-lock.json`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const migrateManifest = files.find((f) => f.path === 'migrate/package.json');
if (migrateManifest) {
  const mdir = mkdtempSync(join(tmpdir(), `golden-path-lock-${out}-migrate-`));
  try {
    writeFileSync(join(mdir, 'package.json'), migrateManifest.content);
    const npmrc = files.find((f) => f.path === '.npmrc');
    if (npmrc) writeFileSync(join(mdir, '.npmrc'), npmrc.content);
    writeFileSync(join(ROOT, '..', 'templates', out, 'migrate', 'package-lock.json'), resolveLock(mdir));
    console.log(`regen-golden-path-lock: wrote templates/${out}/migrate/package-lock.json`);
  } finally {
    rmSync(mdir, { recursive: true, force: true });
  }
}
