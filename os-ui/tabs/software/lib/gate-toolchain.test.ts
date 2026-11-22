/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the gates run on the PLATFORM's pinned toolchain, never the author's
 * USER STORY: As the platform owner I want type check, lint and tests judged by tools I pinned, so an app
 *             cannot turn a gate green by shipping a package-lock.json that maps `typescript`, `eslint` or
 *             `tsx` to a package whose binary exits 0.
 * ARCHITECTURE: the REAL scripts/factory-gates.mjs run as a child process against throwaway projects, with
 *             the REAL pinned toolchain (templates/platform-toolchain, `npm ci` from its lockfile). Forged
 *             tools sit in the project's node_modules (one through a real lockfile + `npm ci`). Negative
 *             twins: the same forged project without the platform toolchain is fooled, and a clean project
 *             still passes with it. The sandbox Job manifest and payload carry the toolchain.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { instantiateGoldenPath } from './golden-path.ts';
import { load as yamlLoad } from 'js-yaml';

const ROOT = resolve(process.cwd(), '..');
const TC_SRC = join(ROOT, 'templates/platform-toolchain');
const GATES = join(ROOT, 'templates/nextjs-web/scripts/factory-gates.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'sf-toolchain-'));
let toolchain = '';

before(() => {
  toolchain = join(tmp, 'toolchain');
  mkdirSync(toolchain);
  for (const f of ['package.json', 'package-lock.json', 'eslint.config.mjs']) copyFileSync(join(TC_SRC, f), join(toolchain, f));
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: toolchain, encoding: 'utf8' });
  assert.equal(r.status, 0, `npm ci of the platform toolchain failed: ${(r.stderr || '').slice(-400)}`);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}
const BASE = {
  'package.json': '{"name":"p","private":true,"type":"module"}',
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }),
  'eslint.config.mjs': 'export default [];\n',
  'src/ok.ts': 'export const n: number = 1;\n',
  'tests/a.test.ts': "import test from 'node:test';\ntest('ok', () => {});\n",
};
const project = (name: string, extra: Record<string, string> = {}) => write(join(tmp, name), { ...BASE, ...extra });
const EXIT0 = '#!/usr/bin/env node\nprocess.exit(0);\n';

function gate(id: string, root: string, tc?: string) {
  const r = spawnSync(process.execPath, [GATES, '--gate', id, '--root', root, ...(tc ? ['--toolchain', tc] : [])], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('POSITIVE: a clean project passes typecheck, lint and tests on the platform toolchain', () => {
  const p = project('clean');
  for (const id of ['typecheck', 'lint', 'tests']) assert.equal(gate(id, p, toolchain).status, 0, `${id}: ${gate(id, p, toolchain).out}`);
});

test('typecheck: a lockfile that maps typescript to a package whose tsc always exits 0 still fails a type error', () => {
  const p = project('forge-ts-lock', {
    'package.json': JSON.stringify({ name: 'p', private: true, type: 'module', devDependencies: { typescript: 'file:./fake-ts' } }),
    'fake-ts/package.json': JSON.stringify({ name: 'typescript', version: '5.9.3', bin: { tsc: 'bin/tsc' } }),
    'fake-ts/bin/tsc': EXIT0,
    'src/bad.ts': "export const n: number = 'not a number';\n",
  });
  const inst = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: p, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: p, encoding: 'utf8' }).status, 0);
  const real = gate('typecheck', p, toolchain);
  assert.notEqual(real.status, 0, 'the forged tsc must not decide');
  assert.match(real.out, /TS2322/);
  // NEGATIVE TWIN: judged by the author's own node_modules (no platform toolchain) the forgery works.
  assert.equal(gate('typecheck', p).status, 0, 'control: the author-owned tool exits 0 over a type error');
});

test('lint: a forged eslint that exits 0 still fails a lint error; the author config is not what judges', () => {
  const p = project('forge-eslint', {
    'node_modules/eslint/package.json': '{"name":"eslint","version":"9.39.5","bin":{"eslint":"bin/eslint.js"}}',
    'node_modules/eslint/bin/eslint.js': EXIT0,
    'src/any.ts': 'export const a: any = 1;\n',
  });
  const real = gate('lint', p, toolchain);
  assert.notEqual(real.status, 0);
  assert.match(real.out, /no-explicit-any/);
  assert.equal(gate('lint', p).status, 0, 'control: the author-owned eslint exits 0 over a lint error');
});

test('tests: a forged tsx loader that exits 0 still fails a failing test', () => {
  const p = project('forge-tsx', {
    'node_modules/tsx/package.json': JSON.stringify({ name: 'tsx', version: '4.23.15', type: 'module', exports: { '.': './index.mjs', './esm': './index.mjs' } }),
    'node_modules/tsx/index.mjs': 'process.exit(0);\n',
    'tests/a.test.ts': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n",
  });
  const g = gate('tests', p, toolchain);
  assert.notEqual(g.status, 0, g.out);
  assert.equal(gate('tests', p).status, 0, 'control: the author-owned loader exits 0 over a failing test');
});

test('tests: the platform tsx loads a CommonJS package that imports extensionless TypeScript (the template shape), not only ESM', () => {
  const p = project('cjs-shape', {
    'package.json': '{"name":"p","private":true}',
    'src/dep.ts': 'export const answer = 42;\n',
    'tests/a.test.ts': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/dep';\ntest('dep', () => assert.equal(answer, 42));\n",
  });
  const g = gate('tests', p, toolchain);
  assert.equal(g.status, 0, g.out);
  // NEGATIVE TWIN: the same shape with a wrong expectation still fails on the platform tsx
  writeFileSync(join(p, 'tests/a.test.ts'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/dep';\ntest('dep', () => assert.equal(answer, 41));\n");
  assert.notEqual(gate('tests', p, toolchain).status, 0);
});

test('the gates never name node_modules/.bin, and a missing platform tool is unavailable, not a pass', () => {
  const src = readFileSync(GATES, 'utf8');
  assert.doesNotMatch(src, /node_modules\/\.bin/);
  const empty = join(tmp, 'empty-toolchain');
  mkdirSync(empty);
  const r = gate('typecheck', project('no-tool'), empty);
  assert.equal(r.status, 3, r.out);
});

// ------------------------------------------------------- the Tekton gates pod ---

type Step = { name: string; image?: string; command?: string[]; args?: string[]; onError?: string; script?: string; workingDir?: string; env?: { name: string }[]; volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[] };
const PIPE = join(ROOT, 'charts/sovereign-agentic-os/files/tekton/pipelines/app-checks.yaml');
const gatesTask = () => {
  const p = yamlLoad(readFileSync(PIPE, 'utf8')) as { spec: { tasks: { name: string; taskSpec?: { steps: Step[]; sidecars?: unknown[]; stepTemplate?: { securityContext?: Record<string, unknown>; volumeMounts?: { name: string; mountPath: string }[] }; workspaces?: { name: string; readOnly?: boolean }[]; volumes: { name: string; emptyDir?: unknown; configMap?: { name: string } }[] } }[] } };
  return p.spec.tasks.find((t) => t.name === 'gates')!.taskSpec!;
};

test('Tekton: every gate runs the platform toolchain by absolute path, read-only, and a toolchain step installs it first', () => {
  const t = gatesTask();
  const names = t.steps.map((s) => s.name);
  assert.equal(names[0], 'toolchain', names.join(','));
  assert.ok(names.indexOf('install') > names.indexOf('policy'), 'the policy is judged before any step that runs the app\'s code');
  const tc = t.steps[0];
  assert.match(tc.script ?? '', /npm ci --ignore-scripts/);
  assert.equal(tc.workingDir, '/platform/toolchain');
  assert.match(tc.script ?? '', /npm_config_https_proxy/, 'the toolchain install goes through the egress proxy');
  for (const id of ['typecheck', 'lint', 'tests', 'build']) {
    const g = t.steps.find((s) => s.name === id)!;
    assert.match(g.script ?? '', /--toolchain \/platform\/toolchain\b/, id);
    assert.doesNotMatch(g.script ?? '', /node_modules/, id);
    assert.equal(g.volumeMounts!.find((v) => v.mountPath === '/platform/toolchain')!.readOnly, true, id);
  }
  // the toolchain comes from the chart's ConfigMap, the install lands in an emptyDir
  assert.equal(t.volumes.find((v) => v.name === 'platform-toolchain-src')!.configMap!.name, 'app-checks-toolchain');
  assert.ok(t.volumes.find((v) => v.name === 'platform-toolchain')!.emptyDir);
});

test('NEGATIVE the policy has no server: no sidecar, nothing listens on loopback, the policy step is a one-shot `opa eval` over the read-only platform policy', () => {
  const t = gatesTask();
  assert.equal(t.sidecars, undefined, 'a sidecar shares the pod network namespace with the app\'s code (tests, build)');
  assert.doesNotMatch(JSON.stringify(t), /8181|OPA_URL|--server/, 'no OPA server address or flag anywhere in the gates task');
  const policy = t.steps.find((s) => s.name === 'policy')!;
  assert.match(String(policy.image), /openpolicyagent\/opa:[^@]+@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(policy.command, ['/opa']);
  assert.deepEqual((policy.args ?? []).slice(0, 1), ['eval']);
  assert.ok((policy.args ?? []).includes('--fail-defined'), 'a violation is the step\'s exit code');
  assert.ok(!(policy.args ?? []).includes('--server'));
  assert.equal(policy.onError, 'continue');
  const ro = (s: Step, mount: string) => (s.volumeMounts ?? []).find((v) => v.mountPath === mount)?.readOnly;
  assert.equal(ro(policy, '/platform/policy'), true);
  assert.equal(ro(policy, '/facts'), true, 'the facts the policy judges are read-only for it');
  // the files the policy judges are written by a platform step that runs before any of the app\'s code
  const facts = t.steps.find((s) => s.name === 'facts')!;
  assert.match(facts.script ?? '', /factory-gates\.mjs --facts \/facts\/facts\.json --root \$\(workspaces\.app\.path\)/);
  assert.ok(t.steps.findIndex((s) => s.name === 'facts') < t.steps.findIndex((s) => s.name === 'policy'));
  // NEGATIVE TWIN: the steps that run the app\'s code mount neither the policy nor the facts
  for (const id of ['install', 'typecheck', 'lint', 'tests', 'build']) {
    const mounts = (t.steps.find((s) => s.name === id)!.volumeMounts ?? []).map((v) => v.mountPath);
    assert.ok(!mounts.includes('/platform/policy') && !mounts.includes('/facts'), `${id} must not see the policy or the facts (${mounts.join(',')})`);
  }
});

test('NEGATIVE the app\'s code works on a COPY: the pushed tree is mounted read-only and judged by policy and scan unchanged', () => {
  const t = gatesTask();
  assert.equal(t.workspaces!.find((w) => w.name === 'app')!.readOnly, true, 'the clone is read-only in the pod that runs the app\'s code');
  assert.ok(t.volumes.find((v) => v.name === 'work')!.emptyDir, 'the copy lives in an emptyDir');
  const names = t.steps.map((s) => s.name);
  assert.ok(names.indexOf('copy') >= 0 && names.indexOf('copy') < names.indexOf('install'));
  for (const id of ['install', 'typecheck', 'lint', 'tests', 'build']) {
    const st = t.steps.find((s) => s.name === id)!;
    assert.equal(st.workingDir, '/work', id);
    assert.doesNotMatch(st.script ?? '', /workspaces\.app\.path/, `${id} must not name the pushed tree`);
  }
  for (const id of ['typecheck', 'lint', 'tests', 'build']) assert.match(t.steps.find((s) => s.name === id)!.script ?? '', /--root \/work /, id);
});

test('every step has a read-only root filesystem (writable scratch is an emptyDir at /tmp and /work)', () => {
  const t = gatesTask();
  assert.equal(t.stepTemplate!.securityContext!.readOnlyRootFilesystem, true);
  assert.ok((t.stepTemplate!.volumeMounts ?? []).some((v) => v.mountPath === '/tmp'));
  assert.ok(t.volumes.find((v) => v.name === 'tmp')!.emptyDir);
  for (const s of t.steps) assert.equal((s as { securityContext?: unknown }).securityContext, undefined, `${s.name} must not override the template`);
});

test('NEGATIVE TWIN: the app\'s own install step does not get the toolchain and runs in the app\'s folder', () => {
  const install = gatesTask().steps.find((s) => s.name === 'install')!;
  assert.match(install.workingDir ?? '', /workspaces\.app\.path/);
  assert.ok(!(install.volumeMounts ?? []).some((v) => v.mountPath.startsWith('/platform')));
});

test('the toolchain is pinned: exact versions, an integrity hash for every locked package, and the five tools present', () => {
  const pkg = JSON.parse(readFileSync(join(TC_SRC, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(TC_SRC, 'package-lock.json'), 'utf8'));
  assert.deepEqual(unpinned(pkg), []);
  assert.deepEqual(noIntegrity(lock), []);
  for (const t of ['typescript', 'eslint', 'tsx', 'typescript-eslint', '@eslint/js']) assert.ok(pkg.dependencies[t], t);
});

function unpinned(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string[] {
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v)).map(([k]) => k);
}
function noIntegrity(lock: { packages: Record<string, { integrity?: string; link?: boolean }> }): string[] {
  return Object.entries(lock.packages).filter(([k, v]) => k && !v.integrity).map(([k]) => k);
}
test('NEGATIVE TWIN: the pin checkers do flag a range and a package without integrity', () => {
  assert.deepEqual(unpinned({ dependencies: { typescript: '^5.9.3', eslint: '9.39.5' } }), ['typescript']);
  assert.deepEqual(noIntegrity({ packages: { '': {}, 'node_modules/x': {}, 'node_modules/y': { integrity: 'sha512-a' } } }), ['node_modules/x']);
});

test('the chart ships the pinned toolchain unchanged (a drifted copy would pin different tools than the ones reviewed)', () => {
  for (const f of ['package.json', 'package-lock.json', 'eslint.config.mjs', 'next-allowlist.json']) {
    assert.equal(readFileSync(join(ROOT, 'charts/sovereign-agentic-os/files/tekton/toolchain', f), 'utf8'), readFileSync(join(TC_SRC, f), 'utf8'), f);
  }
});
