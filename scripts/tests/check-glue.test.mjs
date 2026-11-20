/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Negative twins for the glue-discipline CI rules (scripts/check-glue.mjs), the
 *             fingerprint ratchet, and the guard that keeps the baseline from growing.
 * USER STORY: As the owner I want proof that each of the ten rules really fails CI: fixtures that
 *             violate it must turn the checker red naming that rule — on a minimal tree AND on a
 *             copy of this repository — and a fixed old finding must never make room for a new one.
 * ARCHITECTURE:
 *   - Fixtures live in scripts/tests/glue-fixtures/<RULE>[--<variant>]/ as overlays (paths relative
 *     to the repo root). Nothing is mocked: the real check-glue.mjs, TypeScript parser,
 *     dependency-cruiser, ajv and python3 run as child processes against throwaway trees.
 *   - Minimal tree: a clean tree passes (including an adapter that may call fetch); each overlay
 *     alone fails with exactly its own rule over an empty baseline.
 *   - Repo copy: `git ls-files` of os-ui/ + scripts/ copied, node_modules symlinked. It passes at the
 *     committed baseline; with ALL overlays applied it fails with all ten rule names.
 *   - Ratchet: fixing one baselined finding while adding a new one of the same rule still fails.
 *   - Guard: in a throwaway git repo, a baseline that gains a fingerprint fails `--guard` unless the
 *     same change sets a new `$approvedRaise`; shrinking always passes.
 *   - The evasion cases of the independent verifier live in check-glue-evasions.test.mjs.
 *   - Run: `node --test scripts/tests/check-glue.test.mjs` (needs `npm --prefix os-ui ci`, python3, git).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = join(REPO, 'scripts', 'check-glue.mjs');
const FIXTURES = join(REPO, 'scripts', 'tests', 'glue-fixtures');
export const RULES = [
  'GLUE-1-ADAPTER-DOOR', 'GLUE-2-CREDENTIAL-BOUNDARY', 'GLUE-3-SILENT-FALLBACK', 'GLUE-4-HARDCODED-VERSION',
  'GLUE-5-RECODED-FEATURE', 'GLUE-6-VALIDATED-CONFIG', 'GLUE-7-UNGOVERNED-WRITE', 'GLUE-8-SETINTERVAL',
  'GLUE-9-KERNEL-TAB-ISOLATION', 'GLUE-10-ARTIFACT-CONTRACT',
];
const TWINS = readdirSync(FIXTURES).filter((d) => RULES.includes(d.split('--')[0])).sort();
const run = (root, args = [], script = CHECK) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
export const failedRules = (out) => [...new Set([...out.matchAll(/^(GLUE-\d+-[A-Z0-9-]+): \d+ \(baseline \d+\) — \d+ new violation/gm)].map((m) => m[1]))];
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const overlay = (root, dir) => cpSync(join(FIXTURES, dir), root, { recursive: true });

export function minimalTree() {
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

test('every rule has at least one negative twin', () => {
  for (const rule of RULES) assert.ok(TWINS.some((d) => d.split('--')[0] === rule), `no fixture for ${rule}`);
});

for (const twin of TWINS) {
  const rule = twin.split('--')[0];
  test(`negative twin ${twin}: fails CI naming exactly ${rule}`, () => {
    const root = minimalTree();
    try {
      overlay(root, twin);
      const r = run(root);
      assert.equal(r.status, 1, `expected a failure\n${r.stdout}${r.stderr}`);
      assert.deepEqual(failedRules(r.stderr), [rule], r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('fingerprints: fixing one baselined finding does not make room for a new one', () => {
  const root = minimalTree();
  try {
    put(root, 'os-ui/core/z/old.ts', "export function a() { try { return 1; } catch { return null; } }\n");
    assert.equal(run(root, ['--baseline']).status, 0);
    assert.equal(run(root).status, 0);
    // Fix the old one, add a different one: the count is unchanged, the fingerprint is new.
    put(root, 'os-ui/core/z/old.ts', "export function a() { return 1; }\n");
    put(root, 'os-ui/core/z/new.ts', "export function b() { try { return 2; } catch { return []; } }\n");
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(failedRules(r.stderr), ['GLUE-3-SILENT-FALLBACK']);
    assert.match(r.stderr, /core\/z\/new\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('guard: a baseline that grows fails without a new $approvedRaise; with one it passes; shrinking passes', () => {
  const root = minimalTree();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci');
    put(root, 'os-ui/core/z/old.ts', "export function a() { try { return 1; } catch { return null; } }\n");
    run(root, ['--baseline']);
    git('add', '-A'); git('commit', '-qm', 'base');
    // Grow: a new finding is baselined in the same change.
    put(root, 'os-ui/core/z/new.ts', "export function b() { try { return 2; } catch { return []; } }\n");
    run(root, ['--baseline']);
    let r = run(root, ['--guard', 'HEAD']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /raises the baseline by 1/);
    // The owner-visible marker makes the raise explicit.
    const b = JSON.parse(readFileSync(join(root, 'scripts/structure-baseline.json'), 'utf8'));
    b.glue.$approvedRaise = 'test: owner approved this raise';
    writeFileSync(join(root, 'scripts/structure-baseline.json'), JSON.stringify(b, null, 2));
    r = run(root, ['--guard', 'HEAD']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /approved in this change/);
    // Shrink: remove everything — always allowed.
    put(root, 'os-ui/core/z/old.ts', 'export const a = 1;\n'); put(root, 'os-ui/core/z/new.ts', 'export const b = 2;\n');
    writeFileSync(join(root, 'scripts/structure-baseline.json'), JSON.stringify({ glue: {} }));
    r = run(root, ['--guard', 'HEAD']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // A raised check-structure count is guarded too.
    writeFileSync(join(root, 'scripts/structure-baseline.json'), JSON.stringify({ 'FILE-HEADER': 5, glue: {} }));
    r = run(root, ['--guard', 'HEAD']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the repository at its recorded baseline passes, and with every twin applied fails all ten rules', { timeout: 600_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'glue-repo-'));
  try {
    const files = execFileSync('git', ['ls-files', '-z', 'os-ui', 'scripts'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const f of files) {
      if (f.startsWith('scripts/tests/glue-fixtures/')) continue;
      mkdirSync(dirname(join(root, f)), { recursive: true });
      try { copyFileSync(join(REPO, f), join(root, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; } // deleted in the working tree
    }
    // The working tree's own (possibly uncommitted) checker, config and baseline are what is under test.
    for (const f of ['scripts/check-glue.mjs', 'scripts/glue/ast.mjs', 'scripts/glue/contract.mjs', 'scripts/glue/py_kwargs.py', 'scripts/structure-baseline.json', 'scripts/glue/generators.json', 'os-ui/.dependency-cruiser.cjs', 'os-ui/core/adapters/_contract.ts']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(root, f));
    }
    cpSync(join(REPO, 'scripts/glue/schemas'), join(root, 'scripts/glue/schemas'), { recursive: true });
    symlinkSync(join(REPO, 'os-ui', 'node_modules'), join(root, 'os-ui', 'node_modules'));
    const script = join(root, 'scripts', 'check-glue.mjs');
    const clean = run(root, [], script);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    for (const twin of TWINS) overlay(root, twin);
    const bad = run(root, [], script);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.deepEqual(failedRules(bad.stderr).sort(), [...RULES].sort(), bad.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
