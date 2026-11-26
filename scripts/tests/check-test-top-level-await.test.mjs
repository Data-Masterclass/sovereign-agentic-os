/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    TEST-TOP-LEVEL-AWAIT rule tests — a late top-level await fails, the fixed twin passes
 * USER STORY: As a maintainer I want proof the rule bites: the #365 shape (tests and a root after()
 *             registered, then a top-level await, then more tests) is reported at every late await,
 *             its fixed twin is clean, and the real tree is clean under check-structure.
 * ARCHITECTURE:
 *   - Runs the real AST walk (scripts/lib/test-top-level-await.mjs) on the fixtures in
 *     fixtures/top-level-await/ (named *.fixture.ts so neither a test runner nor the rule's own
 *     *.test.* walk picks them up), with os-ui's own `typescript`, then runs check-structure.mjs
 *     on a throwaway tree (CI=true) and on the real tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lateTopLevelAwaits } from '../lib/test-top-level-await.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const ts = createRequire(join(repo, 'os-ui', 'package.json'))('typescript');
const fixture = (name) => readFileSync(join(here, 'fixtures', 'top-level-await', name), 'utf8');

test('the #365 shape FAILS: every top-level await after the first test() is reported (negative twin)', () => {
  const hits = lateTopLevelAwaits(ts, 'late.test.ts', fixture('late.fixture.ts'));
  assert.deepEqual(hits.map((h) => h.line), [14, 15, 16]);
  assert.ok(hits.every((h) => h.registrar === 'test' && h.registrarLine === 11));
});

test('the fixed twin is clean: awaits before the first registration, or inside functions, are fine', () => {
  assert.deepEqual(lateTopLevelAwaits(ts, 'clean.test.ts', fixture('clean.fixture.ts')), []);
});

test('a root hook opens the window too, and so do .only/.skip forms; a file with no registration is never flagged', () => {
  const hook = "import { before } from 'node:test';\nbefore(() => {});\nconst m = await import('./m');\n";
  assert.deepEqual(lateTopLevelAwaits(ts, 'h.test.mjs', hook).map((h) => [h.registrar, h.line]), [['before', 3]]);
  const only = "describe.only('x', () => {});\nawait Promise.resolve();\n";
  assert.deepEqual(lateTopLevelAwaits(ts, 'o.test.ts', only).map((h) => [h.registrar, h.line]), [['describe', 2]]);
  assert.deepEqual(lateTopLevelAwaits(ts, 'n.test.ts', "const a = await import('./a');\nawait a.run();\n"), []);
});

test('check-structure FAILS a throwaway tree holding the #365 shape, names the rule and the line; its twin passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tla-'));
  try {
    mkdirSync(join(root, 'os-ui'), { recursive: true });
    writeFileSync(join(root, 'os-ui', 'late.test.ts'), fixture('late.fixture.ts'));
    const run = () => spawnSync(process.execPath, [join(repo, 'scripts', 'check-structure.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
    let r = run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /TEST-TOP-LEVEL-AWAIT {2}os-ui\/late\.test\.ts:14 — top-level await after the first test\(\) \(line 11\)/);
    writeFileSync(join(root, 'os-ui', 'late.test.ts'), fixture('clean.fixture.ts'));
    r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check-structure runs the rule and the real tree is clean', () => {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'check-structure.mjs')], { cwd: repo, encoding: 'utf8', env: { ...process.env, CI: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /TEST-TOP-LEVEL-AWAIT/);
});
