#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Regenerate the real npm lockfiles the app scaffolds ship.
 * USER STORY: As a maintainer who changed a scaffold's dependencies I want one command that
 *             re-resolves its lockfile with npm itself, so a generated app's dependency scan keeps
 *             describing what the app really declares.
 * ARCHITECTURE: For each lock family it asks `tabs/software/lib/scaffold-lock.ts` for the exact
 *             manifests a seed commits (`lockInputs`), writes ONLY those into an empty temp
 *             directory, runs `npm install --package-lock-only --ignore-scripts` there, and copies
 *             npm's `package-lock.json` VERBATIM to `tabs/software/lib/scaffolds/locks/`. Nothing
 *             is edited afterwards: a lockfile that is not npm's own output is fiction. Needs
 *             network access to the npm registry. Run from anywhere:
 *               node --experimental-strip-types os-ui/scripts/regen-scaffold-locks.mjs [--check]
 *             `--check` resolves into the temp directory and exits 1 if the committed file differs.
 *             It WILL differ whenever a newer in-range release exists — that is information about
 *             the registry, not an error in the template; the offline drift test is
 *             `tabs/software/lib/scaffold-lock.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT); // the vendor readers resolve `core/app-ui` and `core/app-sdk` from cwd
const LOCKS = join(ROOT, 'tabs', 'software', 'lib', 'scaffolds', 'locks');
const check = process.argv.includes('--check');
const SLUG = 'sovereign-os-scaffold'; // LOCK_PLACEHOLDER_NAME — asserted equal by the drift test
// Pinned: a maintainer's ~/.npmrc may point at a private mirror, and the `resolved` URLs npm writes
// would then carry that host into every generated app. The drift test asserts the host.
const REGISTRY = 'https://registry.npmjs.org/';

// scaffold-lock.ts imports the lockfiles, so a first-ever run needs something to import. These
// stubs are overwritten below before the process exits 0.
mkdirSync(LOCKS, { recursive: true });
for (const family of ['vite', 'api-service']) {
  const p = join(LOCKS, `${family}.package-lock.json`);
  if (!existsSync(p)) writeFileSync(p, '{}\n');
}

const { lockInputs } = await import('../tabs/software/lib/scaffold-lock.ts');
const { viteBaseFiles } = await import('../tabs/software/lib/scaffolds/vite-os.ts');
const { apiServiceFiles } = await import('../tabs/software/lib/scaffolds/api-service.ts');

const FAMILIES = {
  vite: (slug) => viteBaseFiles('App', slug),
  'api-service': (slug) => apiServiceFiles('App', slug),
};

let drift = 0;
for (const [family, scaffold] of Object.entries(FAMILIES)) {
  const dir = mkdtempSync(join(tmpdir(), `scaffold-lock-${family}-`));
  try {
    for (const f of lockInputs(family, scaffold(SLUG), SLUG)) {
      const abs = join(dir, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    const run = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      console.error(`regen-scaffold-locks: npm failed for '${family}':\n${run.stdout}\n${run.stderr}`);
      process.exit(1);
    }
    const fresh = readFileSync(join(dir, 'package-lock.json'), 'utf8');
    const target = join(LOCKS, `${family}.package-lock.json`);
    const committed = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (check) {
      if (fresh !== committed) {
        drift += 1;
        console.error(`regen-scaffold-locks: '${family}' differs from a fresh resolution.`);
      } else {
        console.log(`regen-scaffold-locks: '${family}' matches a fresh resolution.`);
      }
    } else {
      writeFileSync(target, fresh);
      console.log(`regen-scaffold-locks: wrote ${target} (${fresh.length} bytes)${fresh === committed ? ' — unchanged' : ''}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(drift > 0 ? 1 : 0);
