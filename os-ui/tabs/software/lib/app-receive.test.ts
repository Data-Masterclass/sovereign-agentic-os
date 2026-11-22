/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    a push to apps/<slug>/ re-derives the app registry (go-live 1, step 2)
 * USER STORY: As an engineer pushing from VS Code I want the registry to follow my tree, without a
 *             push ever widening who sees an app, promoting it or deleting it.
 * ARCHITECTURE: Offline app store, real ingestFromRepo, a fake tree reader standing in for git; the
 *             real push through the receive gate is covered in app-receive.git.test.ts.
 *             Negative twins: never audience, never retire, never create, never another domain's app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testUser } from '@core/testing/user';
import type { Pusher } from '@core/infra/git-receive';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, getAppBySlugInternal } = await import('./apps.ts');
const { matchesApp, validateAppFile, validateAppDelete, ingestApps } = await import('./app-receive.ts');

const dev = testUser({ id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' });
const pusher: Pusher = { id: 'dan', name: 'Dan', role: 'builder', domains: ['eng'] };
const YAML = 'name: X\nsurface: api\ndeclares:\n  connections: []\n  data: []\n  knowledge: []\n';

test('matchesApp claims files under apps/<slug>/ only', () => {
  assert.equal(matchesApp('apps/inv/app.yaml'), true);
  assert.equal(matchesApp('apps/inv'), false);
  assert.equal(matchesApp('dashboards/x/dashboard.yaml'), false);
});

test('validateAppFile: platform-owned gate files may not be edited by a push', () => {
  assert.match(validateAppFile({ path: 'apps/inv/.tekton/pipeline.yaml', content: 'weakened' }) ?? '', /platform-owned/);
  assert.match(validateAppFile({ path: 'apps/inv/scripts/factory-gates.mjs', content: '// weakened' }) ?? '', /platform-owned/);
  assert.match(validateAppFile({ path: 'apps/inv/policy/app-rules.rego', content: 'package factory' }) ?? '', /platform-owned/);
  assert.equal(validateAppFile({ path: 'apps/inv/src/app/page.tsx', content: 'x' }), null);
  // the whole PLATFORM_OWNED list is enforced on git receive, not only the two gate files
  for (const p of ['Dockerfile', 'next.config.mjs', '.npmrc', '.github/workflows/ci.yml', 'vendor/x/y.js', 'policy/extra.rego']) {
    assert.match(validateAppFile({ path: `apps/inv/${p}`, content: 'x' }) ?? '', /platform-owned/, p);
  }
  // negative twins: k8s/ is validated by the app-deploy kind, the lockfile is the author's
  assert.equal(validateAppFile({ path: 'apps/inv/k8s/deployment.yaml', content: 'x' }), null);
  assert.equal(validateAppFile({ path: 'apps/inv/package-lock.json', content: '{}' }), null);
  assert.equal(validateAppFile({ path: 'apps/inv/README.md', content: 'x' }), null);
});

test('validateAppFile: next.config.* of every extension and depth is platform-owned on a push', () => {
  for (const p of ['next.config.ts', 'next.config.js', 'next.config.cjs', 'next.config.mts', 'src/next.config.mjs', 'a/b/next.config.ts']) {
    assert.match(validateAppFile({ path: `apps/inv/${p}`, content: 'x' }) ?? '', /platform-owned/, p);
  }
  assert.equal(validateAppFile({ path: 'apps/inv/docs/next.config.md', content: 'x' }), null);
});

test('validateAppDelete: deleting ANY platform-owned file (k8s/ included) is refused; source, lockfile and docs may go', () => {
  for (const p of ['Dockerfile', 'next.config.mjs', 'next.config.ts', 'src/next.config.js', '.npmrc', 'policy/app-rules.rego', 'scripts/factory-gates.mjs', 'vendor/x/y.js', '.github/workflows/ci.yml', 'k8s/deployment.yaml']) {
    assert.match(validateAppDelete({ path: `apps/inv/${p}` }) ?? '', /platform-owned/, p);
  }
  // NEGATIVE TWINS
  for (const p of ['src/app/page.tsx', 'package-lock.json', 'README.md', 'docs/next.config.md', 'tests/a.test.ts']) assert.equal(validateAppDelete({ path: `apps/inv/${p}` }), null, p);
  assert.equal(validateAppDelete({ path: 'dashboards/x/Dockerfile' }), null, 'not an app path');
});

test('ingestApps: re-derives from the FULL tree at the pushed sha, not only the changed files', async () => {
  const app = await createApp(dev, { name: 'Pushed', template: 'sovereign-app' });
  const reads: string[] = [];
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: 'c'.repeat(40), files: [{ path: `apps/${app.slug}/app.yaml`, status: 'modified', content: YAML }] },
    { readTree: async (slug, sha) => { reads.push(`${slug}@${sha}`); return [{ path: 'app.yaml', content: YAML }, { path: 'README.md', content: 'hello' }]; } },
  );
  assert.deepEqual(reads, [`${app.slug}@${'c'.repeat(40)}`]);
  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);
});

test('NEGATIVE never retire: deleting every file of an app reports it and keeps the app', async () => {
  const app = await createApp(dev, { name: 'Keep Me', template: 'sovereign-app' });
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: 'd'.repeat(40), files: [{ path: `apps/${app.slug}/app.yaml`, status: 'deleted', content: null }] },
    { readTree: async () => [] },
  );
  assert.equal(report.updated, 0);
  assert.match(report.notes.join(' '), /never retires/);
  assert.ok(await getAppBySlugInternal(app.slug));
});

test('NEGATIVE never create: a slug with no app record is reported, nothing is made', async () => {
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: 'e'.repeat(40), files: [{ path: 'apps/ghost/app.yaml', status: 'added', content: YAML }] },
    { readTree: async () => [{ path: 'app.yaml', content: YAML }] },
  );
  assert.equal(report.created, 0);
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /No app record/);
  assert.equal(await getAppBySlugInternal('ghost'), null);
});

test('NEGATIVE never audience: a pushed app.yaml cannot change the domain, status or owner', async () => {
  const app = await createApp(dev, { name: 'Stays Put', template: 'sovereign-app' });
  const before = { domain: app.domain, status: app.status, owner: app.owner };
  await ingestApps(
    { domain: 'eng', pusher, sha: 'f'.repeat(40), files: [{ path: `apps/${app.slug}/app.yaml`, status: 'modified', content: 'x' }] },
    { readTree: async () => [{ path: 'app.yaml', content: `domain: sales\nvisibility: company\nstatus: live\nowner: mallory\n${YAML}` }] },
  );
  const after = (await getAppBySlugInternal(app.slug))!;
  assert.deepEqual({ domain: after.domain, status: after.status, owner: after.owner }, before);
});

test('NEGATIVE an app of another domain than the repo is not touched', async () => {
  const other = testUser({ id: 'sue', name: 'Sue', domains: ['sales'], role: 'builder' });
  const app = await createApp(other, { name: 'Sales App', template: 'sovereign-app' });
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: '1'.repeat(40), files: [{ path: `apps/${app.slug}/app.yaml`, status: 'modified', content: 'x' }] },
    { readTree: async () => [{ path: 'app.yaml', content: 'name: Hijack\n' }] },
  );
  assert.equal(report.updated, 0);
  assert.equal(report.skipped, 1);
});

// -------------------------------------------- a push starts the checks (Tekton CI) ---

import type { CheckRecord } from './check-record.ts';
import type { ChecksRunner } from './tekton-checks.ts';
const GOLDEN_YAML = `name: X\ntemplate: nextjs-web\nsurface: api\ndeclares:\n  connections: []\n  data: []\n  knowledge: []\n`;
const runningRecord = (sha: string): CheckRecord => ({ sha, status: 'running', trigger: 'push', engine: 'tekton', runRef: `chk-${sha.slice(0, 10)}-1`, startedAt: 't0', finishedAt: null, checks: [], error: null });
const fakeChecks = (calls: { slug: string; sha: string; trigger: string }[], superseded: string[] = []): ChecksRunner => async (i) => {
  calls.push({ slug: i.slug, sha: i.sha, trigger: i.trigger });
  return { record: runningRecord(i.sha), superseded };
};

test('A PUSH STARTS THE CHECKS for the pushed sha of a golden-path app, trigger `push`, and records the running run on the app', async () => {
  const app = await createApp(dev, { name: 'Push Checked', template: 'sovereign-app' });
  const calls: { slug: string; sha: string; trigger: string }[] = [];
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: '2'.repeat(40), files: [{ path: `apps/${app.slug}/src/app/page.tsx`, status: 'modified', content: 'x' }] },
    { readTree: async () => [{ path: 'app.yaml', content: GOLDEN_YAML }], checks: fakeChecks(calls) },
  );
  assert.deepEqual(calls, [{ slug: app.slug, sha: '2'.repeat(40), trigger: 'push' }]);
  assert.match(report.notes.join(' '), /quality checks started/);
  assert.doesNotMatch(report.notes.join(' '), /not started by a push/);
  const stored = (await getAppBySlugInternal(app.slug))!.checks ?? [];
  assert.equal(stored[0].sha, '2'.repeat(40));
  assert.equal(stored[0].status, 'running');
  assert.equal(stored[0].engine, 'tekton');
});

test('SUPERSEDE: the older running record of the app is marked superseded when a newer push starts its run', async () => {
  const app = await createApp(dev, { name: 'Push Twice', template: 'sovereign-app' });
  const calls: { slug: string; sha: string; trigger: string }[] = [];
  const push = (sha: string, superseded: string[]) =>
    ingestApps({ domain: 'eng', pusher, sha, files: [{ path: `apps/${app.slug}/README.md`, status: 'modified', content: 'x' }] }, { readTree: async () => [{ path: 'app.yaml', content: GOLDEN_YAML }], checks: fakeChecks(calls, superseded) });
  await push('3'.repeat(40), []);
  await push('4'.repeat(40), ['3'.repeat(40)]);
  const stored = (await getAppBySlugInternal(app.slug))!.checks ?? [];
  assert.equal(stored.find((r) => r.sha === '3'.repeat(40))!.status, 'superseded');
  assert.equal(stored.find((r) => r.sha === '4'.repeat(40))!.status, 'running');
});

test('NEGATIVE a push to an app the OS serves itself (no container) starts no checks, whatever its app.yaml claims', async () => {
  const app = await createApp(dev, { name: 'Plain Push', template: 'sovereign-app', kind: 'spec' } as never);
  const calls: { slug: string; sha: string; trigger: string }[] = [];
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: '5'.repeat(40), files: [{ path: `apps/${app.slug}/app.yaml`, status: 'modified', content: YAML }] },
    { readTree: async () => [{ path: 'app.yaml', content: YAML }], checks: fakeChecks(calls) },
  );
  assert.equal(calls.length, 0);
  assert.doesNotMatch(report.notes.join(' '), /quality checks started/);
});

test('NEGATIVE a slug with no app record, or another domain\'s app, starts no checks', async () => {
  const calls: { slug: string; sha: string; trigger: string }[] = [];
  await ingestApps({ domain: 'eng', pusher, sha: '6'.repeat(40), files: [{ path: 'apps/ghost/app.yaml', status: 'added', content: GOLDEN_YAML }] }, { readTree: async () => [{ path: 'app.yaml', content: GOLDEN_YAML }], checks: fakeChecks(calls) });
  const other = testUser({ id: 'sue2', name: 'Sue', domains: ['sales'], role: 'builder' });
  const sales = await createApp(other, { name: 'Sales Checked', template: 'sovereign-app' });
  await ingestApps({ domain: 'eng', pusher, sha: '7'.repeat(40), files: [{ path: `apps/${sales.slug}/app.yaml`, status: 'modified', content: GOLDEN_YAML }] }, { readTree: async () => [{ path: 'app.yaml', content: GOLDEN_YAML }], checks: fakeChecks(calls) });
  assert.equal(calls.length, 0);
});

test('NEGATIVE an engine that cannot start is recorded on the app as a finished record with the reason (never silently skipped, never green)', async () => {
  const app = await createApp(dev, { name: 'Engine Down', template: 'sovereign-app' });
  const down: ChecksRunner = async (i) => ({ record: { ...runningRecord(i.sha), status: 'finished', runRef: null, finishedAt: 't1', error: 'no Tekton engine is configured for this OS' }, superseded: [] });
  const report = await ingestApps(
    { domain: 'eng', pusher, sha: '8'.repeat(40), files: [{ path: `apps/${app.slug}/README.md`, status: 'modified', content: 'x' }] },
    { readTree: async () => [{ path: 'app.yaml', content: GOLDEN_YAML }], checks: down },
  );
  assert.match(report.notes.join(' '), /could not start.*Tekton/);
  const stored = (await getAppBySlugInternal(app.slug))!.checks ?? [];
  assert.match(stored[0].error ?? '', /Tekton/);
});
