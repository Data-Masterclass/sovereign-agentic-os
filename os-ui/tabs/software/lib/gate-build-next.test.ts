/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the build gate runs only a `next` the platform allowlisted
 * USER STORY: As the platform owner I want `next build` to be judged only when the app's locked `next` is a
 *             version and integrity hash I allowlisted, so a lockfile that swaps in a `next` whose binary
 *             exits 0 cannot turn the build gate green.
 * ARCHITECTURE: the REAL scripts/factory-gates.mjs as a child process over throwaway projects whose
 *             package-lock.json and node_modules/next are forged or genuine-looking. The allowlist is
 *             templates/platform-toolchain/next-allowlist.json (version + sha512 integrity). `npm ci`
 *             (integrity-checked) is what guarantees the installed bytes match the lock entry, so the gate's
 *             job is to bind that entry to the allowlist. Negative twins: an allowlisted entry runs next.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

const ROOT = resolve(process.cwd(), '..');
const GATES = join(ROOT, 'templates/nextjs-web/scripts/factory-gates.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'sf-build-next-'));
const toolchain = join(tmp, 'toolchain');
const allow = () => JSON.parse(readFileSync(join(ROOT, 'templates/platform-toolchain/next-allowlist.json'), 'utf8')) as { next: { version: string; integrity: string }[] };
const templateNext = () => (JSON.parse(readFileSync(join(ROOT, 'templates/nextjs-web/package-lock.json'), 'utf8')) as { packages: Record<string, { version: string; integrity: string }> }).packages['node_modules/next'];

before(() => {
  mkdirSync(toolchain);
  let list = '{"next":[]}';
  try { list = readFileSync(join(ROOT, 'templates/platform-toolchain/next-allowlist.json'), 'utf8'); } catch { /* absent: the tests below fail on it */ }
  writeFileSync(join(toolchain, 'next-allowlist.json'), list);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function project(name: string, nextEntry: Record<string, unknown> | null): string {
  const dir = join(tmp, name);
  const files: Record<string, string> = {
    'package.json': '{"name":"p","private":true}',
    'package-lock.json': JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': { name: 'p' }, ...(nextEntry ? { 'node_modules/next': nextEntry } : {}) } }),
    'node_modules/next/package.json': '{"name":"next","version":"0.0.0"}',
    'node_modules/next/dist/bin/next': "require('node:fs').writeFileSync('forged-next-ran', '1');\nprocess.exit(0);\n",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  return dir;
}
const ran = (dir: string) => existsSync(join(dir, 'forged-next-ran'));
const build = (dir: string) => {
  const r = spawnSync(process.execPath, [GATES, '--gate', 'build', '--root', dir, '--toolchain', toolchain], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const good = () => ({ version: templateNext().version, integrity: templateNext().integrity, resolved: 'https://registry.npmjs.org/next/-/next.tgz' });

test('the allowlist holds the template\'s own next (version and integrity), so a fresh app passes', () => {
  const t = templateNext();
  assert.ok(allow().next.some((n) => n.version === t.version && n.integrity === t.integrity));
});

test('a locked next whose integrity is not allowlisted is a FAIL and its binary is never run', () => {
  const dir = project('bad-integrity', { ...good(), integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' });
  const r = build(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /allowlist/i);
  assert.equal(ran(dir), false, 'the forged next must not be executed');
});

test('a locked next with an allowlisted version but another integrity, an unknown version, an alias, a link, or no entry is refused', () => {
  const cases: [string, Record<string, unknown> | null][] = [
    ['other-version', { ...good(), version: '99.0.0' }],
    ['alias', { ...good(), name: 'not-next' }],
    ['link', { link: true, resolved: '../evil' }],
    ['no-integrity', { version: good().version }],
    ['absent', null],
  ];
  for (const [name, entry] of cases) {
    const dir = project(`case-${name}`, entry);
    const r = build(dir);
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.equal(ran(dir), false, name);
  }
});

test('NEGATIVE TWIN: an allowlisted entry proceeds to run next (the installed bytes are npm ci\'s integrity-checked ones)', () => {
  const dir = project('allowed', good());
  const r = build(dir);
  assert.equal(ran(dir), true, r.out);
  assert.equal(r.status, 0);
});

test('without --toolchain (an author\'s laptop) the build runs the project\'s own next; no allowlist is consulted', () => {
  const dir = project('laptop', { ...good(), integrity: 'sha512-nope' });
  const r = spawnSync(process.execPath, [GATES, '--gate', 'build', '--root', dir], { encoding: 'utf8' });
  assert.equal(ran(dir), true, `${r.stdout}${r.stderr}`);
});

test('the Tekton build step runs the platform script with the toolchain dir (which carries the allowlist)', () => {
  const p = yamlLoad(readFileSync(join(ROOT, 'charts/sovereign-agentic-os/files/tekton/pipelines/app-checks.yaml'), 'utf8')) as { spec: { tasks: { name: string; taskSpec?: { steps: { name: string; script?: string }[] } }[] } };
  const b = p.spec.tasks.find((t) => t.name === 'gates')!.taskSpec!.steps.find((st) => st.name === 'build')!;
  assert.match(b.script ?? '', /\/platform\/gates\/factory-gates\.mjs --only build --root \/work --toolchain \/platform\/toolchain/);
  assert.ok(existsSync(join(ROOT, 'charts/sovereign-agentic-os/files/tekton/toolchain/next-allowlist.json')), 'the allowlist ships with the toolchain ConfigMap');
});
