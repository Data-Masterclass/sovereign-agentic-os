/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The `vite-os` seed type-checks and builds with its own toolchain
 * USER STORY: As an engineer who creates a `vite-os` app I want its seeded tree to pass the app's
 *             own `npm run build` (`tsc -b && vite build`) untouched, so the first build of a new
 *             app does not fail on the template itself.
 * ARCHITECTURE:
 *   - REAL components only: the tree is exactly what `createApp` seeds for `vite-os`
 *     (`lockedSeed` over `viteOsFiles`: committed lockfile, vendored OS packages, scope pin). npm
 *     installs it from the public registry with `npm ci`; TypeScript and Vite are the app's own
 *     devDependencies, run through the app's own `build` script. Nothing from os-ui is linked in.
 *   - `import.meta.env` is typed by `vite/client`, which Vite documents as a `src/vite-env.d.ts`
 *     triple-slash reference (https://vite.dev/guide/env-and-mode#intellisense-for-typescript).
 *   - NEGATIVE TWIN: the same installed tree without `src/vite-env.d.ts` must fail `tsc -b` with
 *     TS2339 on `ImportMeta.env` — proof that the build really type-checks the seed.
 *   - Needs network access to registry.npmjs.org, so it is skipped unless SCAFFOLD_BUILD=1
 *     (CI: .github/workflows/scaffold-build.yml).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { viteOsFiles } from './vite-os.ts';
import { lockedSeed } from '../scaffold-lock.ts';

const skip = process.env.SCAFFOLD_BUILD === '1' ? false : 'SCAFFOLD_BUILD=1 not set (needs the npm registry)';
const SLUG = 'vite-os-build';
let work = '';

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, maxBuffer: 64 * 1024 * 1024 });
}

before(() => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'vite-os-build-'));
  for (const f of lockedSeed('vite-os', viteOsFiles('Vite Build', SLUG), SLUG)) {
    mkdirSync(dirname(join(work, f.path)), { recursive: true });
    writeFileSync(join(work, f.path), f.content);
  }
  const ci = run('npm', ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], work);
  assert.equal(ci.status, 0, `npm ci failed:\n${ci.stdout}\n${ci.stderr}`);
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test('vite-os seed: `npm run build` (tsc -b && vite build) succeeds on the seeded tree', { skip }, () => {
  const build = run('npm', ['run', 'build'], work);
  assert.equal(build.status, 0, `npm run build failed:\n${build.stdout}\n${build.stderr}`);
  assert.ok(existsSync(join(work, 'dist', 'index.html')), 'vite build wrote dist/index.html');
});

test('NEGATIVE TWIN · without src/vite-env.d.ts the same tree fails tsc on ImportMeta.env', { skip }, () => {
  const dts = join(work, 'src', 'vite-env.d.ts');
  assert.ok(existsSync(dts), 'the seed ships src/vite-env.d.ts');
  rmSync(dts);
  const tsc = run('npx', ['--no-install', 'tsc', '-b', '--force'], work);
  const out = `${tsc.stdout}\n${tsc.stderr}`;
  assert.notEqual(tsc.status, 0, 'tsc must fail without the vite/client reference');
  assert.match(out, /Property 'env' does not exist on type 'ImportMeta'/, out);
});
