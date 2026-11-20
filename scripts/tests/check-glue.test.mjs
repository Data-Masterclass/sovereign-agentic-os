/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Negative twins for the glue-discipline CI rules (scripts/check-glue.mjs).
 * USER STORY: As the owner I want proof that each of the ten rules really fails CI: one fixture
 *             per rule that violates it, and the checker must go red naming that rule — on a
 *             minimal tree AND on a copy of this repository at its recorded baseline.
 * ARCHITECTURE:
 *   - Fixtures live in scripts/tests/glue-fixtures/<RULE>/ as an overlay (paths relative to the
 *     repo root). Nothing here is mocked: the real check-glue.mjs and the real dependency-cruiser
 *     run as child processes against throwaway trees under the OS temp dir.
 *   - Minimal tree: a clean tree passes (including an adapter that may call fetch), each overlay
 *     alone fails with exactly its own rule over a zero baseline.
 *   - Repo copy: `git ls-files` of os-ui/ + scripts/ copied, node_modules symlinked. It passes at
 *     the committed baseline, and with ALL overlays applied it fails with all ten rule names.
 *   - Run: `node --test scripts/tests/check-glue.test.mjs` (needs `npm --prefix os-ui ci`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = join(REPO, 'scripts', 'check-glue.mjs');
const FIXTURES = join(REPO, 'scripts', 'tests', 'glue-fixtures');
const RULES = [
  'GLUE-1-ADAPTER-DOOR', 'GLUE-2-CREDENTIAL-BOUNDARY', 'GLUE-3-SILENT-FALLBACK', 'GLUE-4-HARDCODED-VERSION',
  'GLUE-5-RECODED-FEATURE', 'GLUE-6-VALIDATED-CONFIG', 'GLUE-7-UNGOVERNED-WRITE', 'GLUE-8-SETINTERVAL',
  'GLUE-9-KERNEL-TAB-ISOLATION', 'GLUE-10-ARTIFACT-CONTRACT',
];
const run = (root, script = CHECK) => spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
const failedRules = (out) => [...out.matchAll(/^(GLUE-\d+-[A-Z-]+): \d+ \(baseline \d+\) — \d+ new violation/gm)].map((m) => m[1]);
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const overlay = (root, rule) => cpSync(join(FIXTURES, rule), root, { recursive: true });

function minimalTree() {
  const root = mkdtempSync(join(tmpdir(), 'glue-min-'));
  put(root, 'os-ui/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@core/*': ['./core/*'], '@tabs/*': ['./tabs/*'] } } }));
  put(root, 'os-ui/core/adapters/_contract.ts', "export type Fetched<T> = { ok: true; value: T } | { ok: false; reason: string };\n");
  // The one place a component call is allowed — must NOT fail GLUE-1.
  put(root, 'os-ui/core/adapters/demo/read.ts', "import type { Fetched } from '../_contract';\nexport async function info(url: string): Promise<Fetched<unknown>> {\n  try { return { ok: true, value: await (await fetch(url)).json() }; } catch (e) { return { ok: false, reason: String(e) }; }\n}\n");
  put(root, 'os-ui/core/kernel/offline-mock.ts', "export const refuse = (nodeEnv: string) => nodeEnv === 'production';\n");
  put(root, 'os-ui/tabs/demo/lib/use.ts', "import { info } from '@core/adapters/demo/read';\nexport const load = () => info('/x');\n");
  put(root, 'scripts/structure-baseline.json', JSON.stringify({ glue: {} }));
  return root;
}

test('a clean minimal tree passes (an adapter may call fetch)', () => {
  const root = minimalTree();
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /check-glue: ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const rule of RULES) {
  test(`negative twin: ${rule} fixture fails CI naming exactly that rule`, () => {
    const root = minimalTree();
    try {
      overlay(root, rule);
      const r = run(root);
      assert.equal(r.status, 1, `expected a failure\n${r.stdout}${r.stderr}`);
      assert.deepEqual(failedRules(r.stderr), [rule], r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('the repository at its recorded baseline passes, and with every twin applied fails all ten rules', { timeout: 600_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'glue-repo-'));
  try {
    const files = execFileSync('git', ['ls-files', '-z', 'os-ui', 'scripts'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const f of files) {
      if (f.startsWith('scripts/tests/glue-fixtures/')) continue;
      mkdirSync(dirname(join(root, f)), { recursive: true });
      try { copyFileSync(join(REPO, f), join(root, f)); } catch { /* deleted in the working tree: not part of it */ continue; }
    }
    // The working tree's own (possibly uncommitted) checker, config and baseline are what is under test.
    for (const f of ['scripts/check-glue.mjs', 'scripts/structure-baseline.json', 'scripts/glue/generators.json', 'os-ui/.dependency-cruiser.cjs', 'os-ui/core/adapters/_contract.ts']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(root, f));
    }
    symlinkSync(join(REPO, 'os-ui', 'node_modules'), join(root, 'os-ui', 'node_modules'));
    const script = join(root, 'scripts', 'check-glue.mjs');
    const clean = run(root, script);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    for (const rule of readdirSync(FIXTURES).filter((d) => RULES.includes(d))) overlay(root, rule);
    const bad = run(root, script);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.deepEqual(failedRules(bad.stderr).sort(), [...RULES].sort(), bad.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
