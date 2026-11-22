/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the nextjs-web golden path instantiates into a real, governed repo
 * USER STORY: As a creator (or a coding tool acting for one) I want a new app to start from a real
 *             Next.js project that already carries the rules, the tests, the policy and the deploy
 *             files, so I never configure my way to software - I change working code.
 * ARCHITECTURE: Reads the template from templates/nextjs-web on disk and asserts what
 *             `instantiateGoldenPath` returns: the rules files, the SDK, the scope pin, a real
 *             lockfile, deploy manifests that the OS's own deploy gate accepts, and the function
 *             declaration the OS can register as an agent tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instantiateGoldenPath, isGoldenPath, goldenPathKeyOf, readTemplate, rulesOf, GOLDEN_PATHS } from './golden-path.ts';
import { planAppDeploy, NOT_BUILT_DIGEST } from './native-deploy.ts';
import { parseAppActions } from './app-actions.ts';
import { resolveToolOperation } from './tool-exec.ts';
import { scopePinFindings } from './scope-pin.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ctx = { name: 'Order Desk', slug: 'order-desk', host: 'order-desk.sales.apps.test', registry: 'registry.test/apps', ingressClass: 'nginx', tlsIssuer: 'letsencrypt' };
const tree = () => instantiateGoldenPath('nextjs-web', ctx);
const get = (files: { path: string; content: string }[], p: string) => files.find((f) => f.path === p)?.content ?? '';

test('nextjs-web is a registered golden path; unknown keys are not', () => {
  assert.equal(isGoldenPath('nextjs-web'), true);
  assert.equal(isGoldenPath('nextjs-supabase'), false);
  assert.ok(GOLDEN_PATHS['nextjs-web'].label);
});

test('the GLUE-6 golden fixture is the template as it is in git (it cannot drift from the policy OPA validates)', () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'nextjs-web.golden.json'), 'utf8')) as Record<string, string>;
  const template = readTemplate('nextjs-web');
  for (const [path, content] of Object.entries(golden)) assert.equal(template.find((f) => f.path === path)?.content, content, `${path} drifted from templates/nextjs-web`);
  assert.ok(golden['policy/app-rules.rego'], 'the golden carries the policy');
});

test('the instantiated tree carries every file a real repo needs', () => {
  const paths = tree().map((f) => f.path);
  for (const p of [
    'AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/DECISIONS.md', 'Dockerfile', 'package.json', 'package-lock.json',
    '.npmrc', 'app.yaml', 'actions.yml', 'openapi.yaml', 'policy/app-rules.rego', 'scripts/factory-gates.mjs',
    '.github/workflows/ci.yml', 'k8s/deployment.yaml', 'k8s/service.yaml', 'k8s/ingress.yaml',
    'src/lib/os/index.ts', 'tests/os-door.test.ts', 'vendor/@sovereign-os/app-sdk/index.ts',
  ]) assert.ok(paths.includes(p), `missing ${p}`);
  assert.ok(!paths.some((p) => p.startsWith('node_modules/') || p.startsWith('.next/')), 'no build output in a template');
});

test('the rules file covers every rule area the owner named', () => {
  const agents = rulesOf('nextjs-web').agents;
  for (const h of ['Language rules', 'Code structure', 'Code documentation', 'Unit tests', 'Security rules', 'Identity and authorization', 'Data access', 'Secrets', 'Definition of done']) {
    assert.match(agents, new RegExp(`^## \\d+\\. ${h}`, 'm'), `AGENTS.md lacks "${h}"`);
  }
  assert.match(agents, /OPA/);
  assert.match(agents, /Trino|datastore/i);
});

test('CLAUDE.md imports AGENTS.md instead of copying it, so the two cannot drift', () => {
  assert.ok(rulesOf('nextjs-web').claude.startsWith('@AGENTS.md'));
});

test('the slug is written into package.json and into both name fields of the lockfile', () => {
  const files = tree();
  assert.equal(JSON.parse(get(files, 'package.json')).name, 'order-desk');
  const lock = JSON.parse(get(files, 'package-lock.json'));
  assert.equal(lock.name, 'order-desk');
  assert.equal(lock.packages[''].name, 'order-desk');
  assert.equal(lock.lockfileVersion >= 3, true);
});

test('the lockfile covers exactly the declared dependencies (a bump without a regenerated lock fails)', () => {
  const files = tree();
  const pkg = JSON.parse(get(files, 'package.json'));
  const lock = JSON.parse(get(files, 'package-lock.json'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  for (const [name, range] of Object.entries(declared)) {
    if (String(range).startsWith('file:')) continue;
    assert.equal(lock.packages[`node_modules/${name}`]?.version, range, `${name} is pinned exactly and locked`);
  }
});

test('every dependency is pinned exactly (no ranges) and the OS SDK is vendored, not fetched', () => {
  const pkg = JSON.parse(get(tree(), 'package.json'));
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(String(range), /^(\d+\.\d+\.\d+|file:\.\/vendor\/@sovereign-os\/app-sdk)$/, `${name}: ${range}`);
  }
  assert.equal(scopePinFindings(tree()).filter((f) => f.severity === 'critical' || f.severity === 'high').length, 0);
});

test('the Dockerfile is the template\'s own, byte for byte (platform-owned)', () => {
  const onDisk = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'templates', 'nextjs-web', 'Dockerfile'), 'utf8');
  assert.equal(get(tree(), 'Dockerfile'), onDisk);
});

test('the deploy manifests pass the OS deploy gate once an image digest is pinned, with Next.js-sized limits', () => {
  const files = tree();
  const pinned = files.map((f) => (f.path === 'k8s/deployment.yaml' ? { ...f, content: f.content.replace(NOT_BUILT_DIGEST, DIGEST) } : f));
  const plan = planAppDeploy(pinned, ctx);
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  const dep = get(files, 'k8s/deployment.yaml');
  assert.match(dep, /memory: 512Mi/);
  assert.match(dep, /containerPort: 8080/);
});

test('an unbuilt image is refused by the same gate (negative twin)', () => {
  const plan = planAppDeploy(tree(), ctx);
  assert.equal(plan.ok, false);
  assert.equal(plan.ok ? '' : plan.code, 'image_not_built');
});

test('the function the app exposes parses as a declared action and resolves to a real route', () => {
  const files = tree();
  const parsed = parseAppActions(files);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.actions.map((a) => a.name), ['classify_order']);
  assert.deepEqual(resolveToolOperation(files, 'classify_order'), { method: 'POST', path: '/api/functions/classify-order' });
  assert.match(get(files, 'src/app/api/functions/classify-order/route.ts'), /classifyOrder/);
});

test('goldenPathKeyOf recognises a factory app from its committed app.yaml, and only that', () => {
  assert.equal(goldenPathKeyOf(tree()), 'nextjs-web');
  assert.equal(goldenPathKeyOf([{ path: 'app.yaml', content: 'name: x\nsurface: ui\n' }]), null);
  assert.equal(goldenPathKeyOf([]), null);
});
