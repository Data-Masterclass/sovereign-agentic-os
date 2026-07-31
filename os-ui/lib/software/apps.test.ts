/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cross-instance pinning test for lib/apps.ts.
 * Verifies that appCacheState() is stored on globalThis so the same Map is returned
 * from any module instance in the same process (Next.js API-route bundles share state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing apps.ts so every OpenSearch ping fails fast
// and getCache() initialises an empty in-process Map (offline mode).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const {
  listAppsForUser,
  __resetAppsCache,
  createApp,
  updateAppDocs,
  promoteApp,
  removeAppInternal,
  listAppVersions,
  restoreAppVersion,
  templateFiles,
  containerVersionsToPrune,
  REGISTRY_KEEP_VERSIONS,
} = await import('./apps.ts');

const APP_KEY = Symbol.for('soa.apps.cache');
const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };

test('globalThis: soa.apps.cache — pinned Map survives across module calls', async () => {
  __resetAppsCache();
  // First call: warms the cache into globalThis.
  await listAppsForUser(user);
  const g = (globalThis as any)[APP_KEY];
  assert.ok(g, 'globalThis key is set after first call');
  assert.ok(g.cache instanceof Map, 'cache is a Map on globalThis');
  const ref = g.cache;
  // Second call: must return the same cached Map, not a fresh instance.
  await listAppsForUser(user);
  assert.strictEqual(
    (globalThis as any)[APP_KEY].cache,
    ref,
    'pinned: same Map instance returned on every call',
  );
});

// ---------------------------------------------------------------- versioning --

test('version history: updateAppDocs snapshots prior state; no-op does not churn', async () => {
  __resetAppsCache();
  const owner = { id: 'vh1', name: 'VH1', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'DocVApp', template: 'nextjs-supabase' });

  // No history before any edit.
  assert.equal((await listAppVersions(app.id, owner)).length, 0, 'no history before first edit');

  // First meaningful edit → one prior version captured.
  await updateAppDocs(app.id, owner, { designDecisions: 'v1 decisions' });
  const h1 = await listAppVersions(app.id, owner);
  assert.equal(h1.length, 1);
  assert.equal(h1[0].author, owner.id);
  assert.match(h1[0].summary, /edit docs/);

  // Identical re-save → no new version churn.
  await updateAppDocs(app.id, owner, { designDecisions: 'v1 decisions' });
  assert.equal((await listAppVersions(app.id, owner)).length, 1, 'no-op does not create a version');
});

test('version history: listed newest-first; multiple edits accumulate', async () => {
  __resetAppsCache();
  const owner = { id: 'vh2', name: 'VH2', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'MultiVApp', template: 'service' });

  await updateAppDocs(app.id, owner, { designDecisions: 'edit-1' });
  await updateAppDocs(app.id, owner, { designDecisions: 'edit-2' });
  const hist = await listAppVersions(app.id, owner);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].version, 2, 'newest first');
  assert.equal(hist[1].version, 1, 'oldest last');
});

test('version history: restore reverts content and snapshots current state first', async () => {
  __resetAppsCache();
  const owner = { id: 'vh3', name: 'VH3', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'RestoreVApp', template: 'script' });
  const original = app.designDecisions;

  // Edit → captures v1 (the original before the edit).
  await updateAppDocs(app.id, owner, { designDecisions: 'edited decisions' });

  // Restore v1 → content reverts to original; current "edited" state is
  // snapshotted as v2, making the restore itself auditable + reversible.
  const restored = await restoreAppVersion(app.id, owner, 1);
  assert.equal(restored.designDecisions, original, 'content reverts to the v1 snapshot');

  const hist = await listAppVersions(app.id, owner);
  assert.equal(hist.length, 2, 'restore snapshots current state → two versions total');
  assert.equal(hist[0].version, 2, 'newest first');
  assert.match(hist[0].summary, /restore of v1/);

  // Restoring a non-existent version throws 404.
  await assert.rejects(
    restoreAppVersion(app.id, owner, 99),
    (e: Error & { status?: number }) => { assert.equal(e.status, 404); return true; },
  );
});

test('version history: delete (removeAppInternal) purges the app version log', async () => {
  __resetAppsCache();
  const owner = { id: 'vh4', name: 'VH4', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'DeleteVApp', template: 'dashboard' });
  await updateAppDocs(app.id, owner, { designDecisions: 'some content' });
  assert.equal((await listAppVersions(app.id, owner)).length, 1);

  await removeAppInternal(app.id);

  // A fresh app created afterwards has no leaked version history.
  const fresh = await createApp(owner, { name: 'FreshVApp', template: 'dashboard' });
  assert.equal((await listAppVersions(fresh.id, owner)).length, 0, 'purge leaves no leaked history');
});

test('version history: non-editor is rejected 403 on restore (view-list allowed)', async () => {
  __resetAppsCache();
  const owner  = { id: 'vh5owner',  name: 'Owner',  domains: ['sales'], role: 'admin'   as const };
  const viewer = { id: 'vh5viewer', name: 'Viewer', domains: ['sales'], role: 'creator' as const };

  const app = await createApp(owner, { name: 'SharedVApp', template: 'service' });
  // Promote to Shared so the viewer can see it (Personal is owner-only).
  await promoteApp(app.id, owner);
  await updateAppDocs(app.id, owner, { designDecisions: 'shared content' });

  // Viewer can LIST the version history (view-scoped).
  const hist = await listAppVersions(app.id, viewer);
  assert.equal(hist.length, 1, 'viewer can list versions');

  // But viewer cannot RESTORE (edit-scoped) — must get 403.
  await assert.rejects(
    restoreAppVersion(app.id, viewer, 1),
    (e: Error & { status?: number }) => { assert.equal(e.status, 403); return true; },
  );
});

// -------------------------------------------------- runnable scaffold (task 132) --

test('scaffold: nextjs-supabase seeds a runnable App Router app + a correct Dockerfile', () => {
  const files = templateFiles('nextjs-supabase', 'Probe App', 'probe-app');
  const byPath = (p: string) => files.find((f) => f.path === p);

  // App Router source is present so `next build` has an app/ directory to compile.
  const layout = byPath('app/layout.tsx');
  const page = byPath('app/page.tsx');
  assert.ok(layout, 'app/layout.tsx is seeded');
  assert.ok(page, 'app/page.tsx is seeded');
  assert.match(layout!.content, /<html/, 'layout renders <html>');
  assert.match(layout!.content, /<body>\{children\}<\/body>/, 'layout renders children in <body>');
  assert.match(page!.content, /Probe App/, 'page renders the app name');
  assert.match(page!.content, /Sovereign Agentic OS/, 'page credits the OS');
  assert.doesNotMatch(page!.content, /supabase/i, 'page makes no runtime Supabase call');

  // Dockerfile: installs (not `npm ci`, no swallowed errors), builds, serves on 8080.
  const docker = byPath('Dockerfile');
  assert.ok(docker, 'Dockerfile is seeded');
  assert.match(docker!.content, /RUN npm install/, 'uses npm install (no lockfile seeded)');
  assert.doesNotMatch(docker!.content, /npm ci/, 'does not use npm ci');
  assert.doesNotMatch(docker!.content, /\|\| true/, 'does not swallow install errors');
  assert.match(docker!.content, /RUN npm run build/, 'runs next build');
  assert.match(docker!.content, /ENV PORT=8080/, 'sets PORT=8080');
  assert.match(docker!.content, /ENV HOSTNAME=0\.0\.0\.0/, 'binds 0.0.0.0');
  assert.match(docker!.content, /EXPOSE 8080/, 'exposes 8080');

  // package.json carries the TS devDeps so `next build` type-checks without network.
  const pkg = byPath('package.json');
  assert.ok(pkg, 'package.json is seeded');
  const parsed = JSON.parse(pkg!.content) as { devDependencies?: Record<string, string> };
  assert.ok(parsed.devDependencies?.typescript, 'typescript devDependency seeded');
});

// ------------------------------------------------------- surface declaration --

test('createApp: a declared surface (ui) wins + is recorded on the app record', async () => {
  __resetAppsCache();
  // The 'service' scaffold would otherwise infer api-heavy; declaring ui wins.
  const app = await createApp(user, { name: 'Declared UI', template: 'service', surface: 'ui' });
  assert.equal(app.declaredSurface, 'ui', 'declaration recorded on the record');
  assert.deepEqual(app.surface, { ui: true, api: false }, 'declaration wins → ui-only');
});

test('createApp: NO declaration → surface is inferred from the scaffold (back-compat)', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Inferred', template: 'nextjs-supabase' });
  assert.equal(app.declaredSurface, undefined, 'no declaration recorded');
  // The nextjs scaffold has a web dep + page → ui true.
  assert.equal(app.surface.ui, true, 'inferred ui from the scaffold');
});

test('createApp: an invalid surface arg is ignored → falls back to inference', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Bad Surface', template: 'service', surface: 'nope' as never });
  assert.equal(app.declaredSurface, undefined, 'invalid declaration dropped');
});

// ------------------------------------------------- Sovereign standard template --

test('createApp: the DEFAULT template is the Sovereign standard app', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Default Std' });
  assert.equal(app.template, 'sovereign-app', 'no template named → sovereign-app');
  assert.deepEqual(app.surface, { ui: true, api: false }, 'app.yaml declares surface: ui');
  // The docs handed to the Build assistant carry the skeleton guide.
  assert.match(app.docs, /Sovereign standard app/, 'docs identify the standard app');
  assert.match(app.docs, /epics\//, 'docs describe the epics/<epic>/<story> structure');
  assert.match(app.docs, /identity contract/i, 'docs state the identity contract');
});

test('templateFiles: sovereign-app ships the full standard-app skeleton', () => {
  const paths = templateFiles('sovereign-app', 'Std App', 'std-app').map((f) => f.path);
  for (const p of [
    'src/App.tsx',
    'src/template/sections.tsx',
    'src/template/identity.tsx',
    'src/template/scope.ts',
    'src/template/pages/Admin.tsx',
    'src/template/pages/Overview.tsx',
    'src/core/store.ts',
    'app.yaml',
    'README.md',
    'Dockerfile',
    '.forgejo/workflows/ci.yml',
  ]) {
    assert.ok(paths.includes(p), `scaffold includes ${p}`);
  }
});

// ---------------------------------------------------- four-template picker ----

test('APP_TEMPLATES: the create picker offers exactly the four choices, Application first', async () => {
  const { APP_TEMPLATES } = await import('./apps.ts');
  assert.deepEqual(
    APP_TEMPLATES.map((t: { key: string }) => t.key),
    ['sovereign-app', 'website', 'api-service', 'empty'],
  );
  assert.equal(APP_TEMPLATES[0].label, 'Application', 'the default is labelled Application');
});

test('createApp: website → public Vite site, surface ui, docs carry the page contract', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Acme Site', template: 'website' });
  assert.equal(app.template, 'website');
  assert.deepEqual(app.surface, { ui: true, api: false }, 'app.yaml declares surface: ui');
  assert.match(app.docs, /How epics add pages/, 'docs are the sections contract');
  const paths = templateFiles('website', 'Acme Site', 'acme-site').map((f) => f.path);
  assert.ok(paths.includes('src/sections.tsx') && paths.includes('nginx.conf'), 'sections + shared infra');
});

test('createApp: api-service → headless, surface api declared (never mislabeled)', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Billing API', template: 'api-service' });
  assert.equal(app.template, 'api-service');
  assert.deepEqual(app.surface, { ui: false, api: true }, 'app.yaml declares surface: api');
  const paths = templateFiles('api-service', 'Billing API', 'billing-api').map((f) => f.path);
  assert.ok(paths.includes('server.mjs'), 'ships the zero-dep server');
  assert.ok(!paths.includes('index.html'), 'no UI entry');
});

test('createApp: empty → the bare minimum that still builds and deploys', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Scratch', template: 'empty' });
  assert.equal(app.template, 'empty');
  assert.deepEqual(app.surface, { ui: true, api: false });
  const paths = templateFiles('empty', 'Scratch', 'scratch').map((f) => f.path);
  for (const p of ['src/main.tsx', 'src/App.tsx', 'Dockerfile', '.forgejo/workflows/ci.yml']) {
    assert.ok(paths.includes(p), `minimal scaffold includes ${p}`);
  }
});

test('createApp: legacy templates still work for existing flows (not in the picker)', async () => {
  __resetAppsCache();
  const app = await createApp(user, { name: 'Legacy Vite', template: 'vite-os' });
  assert.equal(app.template, 'vite-os', 'legacy keys keep creating');
});

test('active-domain: a My app created in domain A is hidden when domain B is active, shown under A / All', async () => {
  __resetAppsCache();
  const owner = { id: 'dsc1', name: 'DSC', domains: ['sales'], role: 'admin' as const };
  await createApp(owner, { name: 'SalesApp', template: 'empty' }); // Personal, domain = sales

  // Acting in a different domain (auth.ts narrows user.domains to [active]) → hidden.
  const inFinance = { ...owner, domains: ['finance'] };
  assert.equal((await listAppsForUser(inFinance)).some((a) => a.name === 'SalesApp'), false, 'hidden in other domain');

  // Acting in sales → shown.
  assert.equal((await listAppsForUser(owner)).some((a) => a.name === 'SalesApp'), true, 'shown in its domain');

  // All Domains (every membership) → shown.
  const allDomains = { ...owner, domains: ['sales', 'finance'] };
  assert.equal((await listAppsForUser(allDomains)).some((a) => a.name === 'SalesApp'), true, 'shown under All Domains');
});

// -------------------------------------------------------------------- registry prune --
//
// The pure prune policy behind the CI "Prune old registry versions" step: keep the
// newest N immutable SHA tags plus the protected `latest`, DELETE the rest. Proves
// DELETEs are issued only for versions beyond the newest 2 — and NONE when <= 2 exist.

test('containerVersionsToPrune: deletes versions beyond the newest 2 (by push time)', () => {
  // Five real builds + the floating latest, given out of order to prove sorting.
  const versions = [
    { version: 'latest', created_at: '2026-07-31T10:00:00Z' },
    { version: 'sha-oldest', created_at: '2026-07-27T09:00:00Z' },
    { version: 'sha-newest', created_at: '2026-07-31T09:59:00Z' },
    { version: 'sha-mid1', created_at: '2026-07-29T12:00:00Z' },
    { version: 'sha-mid2', created_at: '2026-07-30T08:00:00Z' },
    { version: 'sha-old2', created_at: '2026-07-28T06:00:00Z' },
  ];
  const toDelete = containerVersionsToPrune(versions, 2);
  // Newest 2 SHA tags (sha-newest, sha-mid2) + latest are kept; the 3 older SHA tags go.
  assert.deepEqual(toDelete, ['sha-mid1', 'sha-old2', 'sha-oldest'], 'deletes exactly the 3 oldest SHA tags');
  assert.equal(toDelete.includes('latest'), false, 'never deletes the protected latest tag');
  assert.equal(toDelete.includes('sha-newest'), false, 'keeps the newest');
  assert.equal(toDelete.includes('sha-mid2'), false, 'keeps the 2nd-newest');
});

test('containerVersionsToPrune: returns [] when <= keep prunable versions exist', () => {
  assert.deepEqual(containerVersionsToPrune([], 2), [], 'no versions → nothing to delete');
  assert.deepEqual(
    containerVersionsToPrune(
      [{ version: 'latest', created_at: '2026-07-31T10:00:00Z' }, { version: 'sha-a', created_at: '2026-07-31T09:00:00Z' }],
      2,
    ),
    [],
    'one SHA tag (+ latest) → nothing to delete',
  );
  assert.deepEqual(
    containerVersionsToPrune(
      [
        { version: 'sha-a', created_at: '2026-07-31T09:00:00Z' },
        { version: 'sha-b', created_at: '2026-07-30T09:00:00Z' },
      ],
      2,
    ),
    [],
    'exactly 2 SHA tags → nothing to delete',
  );
});

test('containerVersionsToPrune: default keep is REGISTRY_KEEP_VERSIONS (2)', () => {
  assert.equal(REGISTRY_KEEP_VERSIONS, 2);
  const versions = [
    { version: 'a', created_at: '2026-07-31T00:00:00Z' },
    { version: 'b', created_at: '2026-07-30T00:00:00Z' },
    { version: 'c', created_at: '2026-07-29T00:00:00Z' },
  ];
  assert.deepEqual(containerVersionsToPrune(versions), ['c'], 'default keeps newest 2, deletes 1');
});
