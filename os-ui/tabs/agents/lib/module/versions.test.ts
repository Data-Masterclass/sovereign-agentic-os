/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53e — the module's pinned versions come from os-ui's lockfile at a known path
 * USER STORY: As the operator I want the generator to read its versions from one file the image
 *             puts at a fixed place, and to say which path is missing when it is not there.
 * ARCHITECTURE:
 *   - `hostModuleInputs()` against the checkout's lockfile (`<cwd>/package-lock.json`) and against
 *     an explicit path; the versions must equal the installed packages' own `package.json`. The
 *     BUILT-server twin is `scripts/check-built-module-inputs.mjs` (CI `build` job).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';
import { MODULE_PACKAGES } from '@tabs/agents/lib/module/generate';

test('the versions are the lockfile entries — equal to what is installed, no module resolution', () => {
  const { versions, hostLock } = hostModuleInputs();
  for (const p of MODULE_PACKAGES) {
    const installed = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules', p, 'package.json'), 'utf8')).version;
    assert.equal(versions[p], installed, p);
    assert.equal(hostLock.packages[`node_modules/${p}`]?.version, installed);
  }
});

test('negative twins: a missing lockfile names its path; a file that is not a lockfile is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wp53e-lock-'));
  assert.throws(() => hostModuleInputs(path.join(dir, 'package-lock.json')), new RegExp(`no package-lock.json at ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  writeFileSync(path.join(dir, 'bad.json'), '{"name":"x"}');
  assert.throws(() => hostModuleInputs(path.join(dir, 'bad.json')), /not an npm lockfile/);
  writeFileSync(path.join(dir, 'partial.json'), JSON.stringify({ packages: { 'node_modules/@langchain/core': { version: '1.0.0' } } }));
  assert.throws(() => hostModuleInputs(path.join(dir, 'partial.json')), /no installed version for @langchain\/langgraph/);
});
