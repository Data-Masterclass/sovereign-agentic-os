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
import { evaluateGates } from './gates.ts';
import { buildGatesJobManifest, runGatesSandbox } from './sandbox-gates.ts';

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

test('the gates never name node_modules/.bin, and a missing platform tool is unavailable, not a pass', () => {
  const src = readFileSync(GATES, 'utf8');
  assert.doesNotMatch(src, /node_modules\/\.bin/);
  const empty = join(tmp, 'empty-toolchain');
  mkdirSync(empty);
  const r = gate('typecheck', project('no-tool'), empty);
  assert.equal(r.status, 3, r.out);
});

// ---------------------------------------------------------- the sandbox Job ---

const spec = { name: 'gates-a-t1', namespace: 'agentic-sandbox', slug: 'a', nodeImage: 'node:test', opaImage: 'opa:test', timeoutMs: 600_000, proxyUrl: 'http://proxy:3128' };
type Ctr = { name: string; command?: string[]; workingDir?: string; env?: { name: string }[]; volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[] };
const podOf = (m: Record<string, unknown>) => ((m.spec as { template: { spec: { initContainers: Ctr[]; containers: Ctr[] } } }).template.spec);

test('Job: every gate runs the platform toolchain by absolute path, read-only, and a toolchain step installs it first', () => {
  const pod = podOf(buildGatesJobManifest(spec));
  const names = pod.initContainers.map((c) => c.name);
  assert.ok(names.indexOf('toolchain') > names.indexOf('writer') && names.indexOf('toolchain') < names.indexOf('install'), names.join(','));
  const tc = pod.initContainers.find((c) => c.name === 'toolchain')!;
  assert.deepEqual(tc.command!.slice(0, 2), ['npm', 'ci']);
  assert.ok(tc.command!.includes('--ignore-scripts'));
  assert.equal(tc.workingDir, '/platform/toolchain');
  assert.ok(tc.env!.some((e) => /proxy/i.test(e.name)), 'the toolchain install goes through the egress proxy');
  for (const g of pod.containers) {
    const line = g.command!.join(' ');
    assert.match(line, /--toolchain \/platform\/toolchain/, g.name);
    assert.doesNotMatch(line, /node_modules/, g.name);
    assert.equal(g.volumeMounts!.find((v) => v.mountPath === '/platform')!.readOnly, true, g.name);
  }
});

test('NEGATIVE TWIN: the unrelated project install step does not get the toolchain files and the toolchain step is not the app install', () => {
  const pod = podOf(buildGatesJobManifest(spec));
  const install = pod.initContainers.find((c) => c.name === 'install')!;
  assert.equal(install.workingDir, '/work');
  assert.ok(!install.volumeMounts!.some((v) => v.mountPath === '/platform'));
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

test('payload: the platform toolchain files travel with the platform gate files', async () => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const term = (name: string, exitCode: number) => ({ name, state: { terminated: { exitCode, reason: 'Completed' } } });
  const k8s = async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (method === 'DELETE') return { status: 404, body: {} };
    if (method === 'POST' && path.endsWith('/jobs')) return { status: 201, body: { metadata: { uid: 'u' } } };
    if (method === 'POST') return { status: 201, body: {} };
    if (path.includes('/pods?')) return { status: 200, body: { items: [{ metadata: { name: 'p', ownerReferences: [{ uid: 'u' }] }, status: { initContainerStatuses: [term('toolchain', 0), term('install', 0)], containerStatuses: ['typecheck', 'lint', 'tests', 'build', 'policy'].map((n) => term(n, 0)) } }] } };
    if (path.includes('/jobs/')) return { status: 200, body: { status: { succeeded: 1 } } };
    return { status: 404, body: {} };
  };
  const files = instantiateGoldenPath('nextjs-web', { name: 'A', slug: 'a', host: 'a.d.apps.test', registry: 'r/apps', ingressClass: 'nginx' });
  await runGatesSandbox('a', files, { k8s, k8sText: async () => ({ status: 200, text: '' }), namespace: 'agentic-sandbox', nodeImage: 'node:test', opaImage: 'opa:test', runId: 't1', sleep: async () => {} });
  const script = String(((calls.find((c) => c.method === 'POST' && c.path.endsWith('/secrets'))?.body ?? {}).stringData as Record<string, string>)['write.sh']);
  const lock = readFileSync(join(TC_SRC, 'package-lock.json'), 'utf8');
  const line = script.split('\n').find((l) => l.endsWith("> '/platform/toolchain/package-lock.json'"));
  assert.ok(line, 'the toolchain lockfile is written under /platform/toolchain');
  assert.equal(Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(line!)![1], 'base64').toString('utf8'), lock);
  for (const p of ['package.json', 'eslint.config.mjs']) assert.ok(script.includes(`> '/platform/toolchain/${p}'`), p);
});

test('a toolchain that failed to install blocks the gates (it is not a pass and not silently skipped)', async () => {
  const term = (name: string, exitCode: number) => ({ name, state: { terminated: { exitCode, reason: 'Error' } } });
  const k8s = async (method: string, path: string) => {
    if (method === 'DELETE') return { status: 404, body: {} };
    if (method === 'POST' && path.endsWith('/jobs')) return { status: 201, body: { metadata: { uid: 'u' } } };
    if (method === 'POST') return { status: 201, body: {} };
    if (path.includes('/pods?')) return { status: 200, body: { items: [{ metadata: { name: 'p', ownerReferences: [{ uid: 'u' }] }, status: { initContainerStatuses: [term('toolchain', 1)], containerStatuses: [] } }] } };
    if (path.includes('/jobs/')) return { status: 200, body: { status: { failed: 1 } } };
    return { status: 404, body: {} };
  };
  const files = instantiateGoldenPath('nextjs-web', { name: 'A', slug: 'a', host: 'a.d.apps.test', registry: 'r/apps', ingressClass: 'nginx' });
  const out = await runGatesSandbox('a', files, { k8s, k8sText: async () => ({ status: 200, text: 'npm ERR!' }), namespace: 'agentic-sandbox', nodeImage: 'node:test', opaImage: 'opa:test', runId: 't2', sleep: async () => {} });
  const v = evaluateGates(out);
  assert.equal(v.passed, false);
  assert.ok(v.blocking.some((b) => b.id === 'toolchain'), JSON.stringify(v.blocking.map((b) => b.id)));
});
