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
const { matchesApp, validateAppFile, ingestApps } = await import('./app-receive.ts');

const dev = testUser({ id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' });
const pusher: Pusher = { id: 'dan', name: 'Dan', role: 'builder', domains: ['eng'] };
const YAML = 'name: X\nsurface: api\ndeclares:\n  connections: []\n  data: []\n  knowledge: []\n';

test('matchesApp claims files under apps/<slug>/ only', () => {
  assert.equal(matchesApp('apps/inv/app.yaml'), true);
  assert.equal(matchesApp('apps/inv'), false);
  assert.equal(matchesApp('dashboards/x/dashboard.yaml'), false);
});

test('validateAppFile: platform-owned gate files may not be edited by a push', () => {
  assert.match(validateAppFile({ path: 'apps/inv/scripts/factory-gates.mjs', content: '// weakened' }) ?? '', /platform-owned/);
  assert.match(validateAppFile({ path: 'apps/inv/policy/app-rules.rego', content: 'package factory' }) ?? '', /platform-owned/);
  assert.equal(validateAppFile({ path: 'apps/inv/src/app/page.tsx', content: 'x' }), null);
  assert.equal(validateAppFile({ path: 'apps/inv/README.md', content: 'x' }), null);
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
