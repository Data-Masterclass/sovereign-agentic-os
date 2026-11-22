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
 *             VERBATIM to templates/<key>/package-lock.json under the placeholder name. Needs network.
 *               cd os-ui && node --experimental-strip-types --import ./scripts/test-setup.mjs scripts/regen-golden-path-lock.mjs [nextjs-web]
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
process.env.GOLDEN_PATH_TEMPLATES_DIR = join(ROOT, '..', 'templates');
const key = process.argv[2] ?? 'nextjs-web';
const { goldenPathFiles, LOCK_PLACEHOLDER } = await import('../tabs/software/lib/golden-path.ts');

const dir = mkdtempSync(join(tmpdir(), `golden-path-lock-${key}-`));
try {
  for (const f of goldenPathFiles(key, { name: 'App', slug: LOCK_PLACEHOLDER })) {
    if (!/(^|\/)(package\.json|\.npmrc)$/.test(f.path)) continue;
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  const run = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`regen-golden-path-lock: npm failed:\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
  }
  copyFileSync(join(dir, 'package-lock.json'), join(ROOT, '..', 'templates', key, 'package-lock.json'));
  console.log(`regen-golden-path-lock: wrote templates/${key}/package-lock.json`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
