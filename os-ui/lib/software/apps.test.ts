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
  renameApp,
  moveApp,
  getAppForUser,
  templateFiles,
  containerVersionsToPrune,
  REGISTRY_KEEP_VERSIONS,
  dirListing,
  repoHtmlUrl,
  repoSharedByLiveApp,
  patchAppDesign,
  reconcileBuiltStatus,
  normalizeAppMembers,
  listAppMembers,
  addAppMember,
  removeAppMember,
  getAppBySlugForUser,
} = await import('./apps.ts');
const { __resetUsers, createUser } = await import('../platform-admin/users.ts');
const { snapshotFiles } = await import('./snapshot.ts');
const { exposedConnectionTools } = await import('../infra/agent-governed.ts');
import type { App, AppEpic } from './apps.ts';
const { config } = await import('../core/config.ts');

/** Minimal App stub — only the fields repoSharedByLiveApp reads matter. */
function appStub(id: string, slug: string, status: 'active' | 'archived'): App {
  return { id, slug, status, repo: { fullName: `gitea_admin/${slug}`, htmlUrl: '', seeded: [] } } as unknown as App;
}

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

// ------------------------------------------------ rename: display name + FROZEN slug --

const owner = { id: 'ro1', name: 'RO1', domains: ['sales'], role: 'creator' as const };

test('renameApp: the physical slug (repo/image/container/CI identity) stays FROZEN across a rename', async () => {
  __resetAppsCache();
  const app = await createApp(owner, { name: 'Renewals Tracker', template: 'service' });
  const frozenSlug = app.slug;
  assert.equal(frozenSlug, 'renewals-tracker', 'slug derived from the create-time name');
  assert.equal(app.subdomain.split('.')[0], frozenSlug, 'subdomain host = slug');

  const renamed = await renameApp(app.id, owner, 'Contract Renewals');
  assert.equal(renamed.name, 'Contract Renewals', 'DISPLAY name changed');
  // THE key assertion — nothing physical moved: image/repo/container FQN + subdomain
  // are all keyed off slug, which is byte-identical to before the rename.
  assert.equal(renamed.slug, frozenSlug, 'slug FROZEN — image/repo/container identity never moves');
  assert.equal(renamed.subdomain.split('.')[0], frozenSlug, 'the per-app host is unchanged');
  assert.equal(renamed.repo.fullName.split('/')[1] || frozenSlug, frozenSlug, 'the CI repo name is unchanged');
});

test('renameApp: owner allowed; shared admits an in-domain domain_admin; a non-owner non-admin denied; empty rejected', async () => {
  __resetAppsCache();
  const promoter = { id: 'padm', name: 'PAdm', domains: ['sales'], role: 'domain_admin' as const };
  const app = await createApp(owner, { name: 'Private App', template: 'service' });

  // Owner may rename a Personal app.
  assert.equal((await renameApp(app.id, owner, 'Private Renamed')).name, 'Private Renamed');
  // A different domain_admin is NOT the owner and cannot manage a PRIVATE (Personal) app.
  const otherAdmin = { id: 'other', name: 'Other', domains: ['sales'], role: 'domain_admin' as const };
  await assert.rejects(
    () => renameApp(app.id, otherAdmin, 'Hijack'),
    (e: Error & { status?: number }) => e.status === 403,
  );
  // Empty / whitespace name → 400.
  await assert.rejects(
    () => renameApp(app.id, owner, '   '),
    (e: Error & { status?: number }) => e.status === 400,
  );

  // Promote Personal → Shared (domain_admin+ gate), then an in-domain domain_admin may rename it.
  await promoteApp(app.id, promoter);
  const shared = await renameApp(app.id, otherAdmin, 'Shared Renamed');
  assert.equal(shared.name, 'Shared Renamed', 'a Shared app admits an in-domain domain_admin');
  assert.equal(shared.slug, app.slug, 'still frozen after the shared rename');

  // A bare creator who is not the owner still may not rename the shared app.
  const stranger = { id: 'nobody', name: 'Nobody', domains: ['sales'], role: 'creator' as const };
  await assert.rejects(
    () => renameApp(app.id, stranger, 'Nope'),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('renameApp: no-op (same name) does not churn the version log', async () => {
  __resetAppsCache();
  const app = await createApp(owner, { name: 'Steady', template: 'service' });
  const before = (await listAppVersions(app.id, owner)).length;
  const same = await renameApp(app.id, owner, 'Steady');
  assert.equal(same.name, 'Steady');
  assert.equal((await listAppVersions(app.id, owner)).length, before, 'no version churn on a no-op rename');
  // A real rename records exactly one snapshot.
  await renameApp(app.id, owner, 'Steady v2');
  assert.equal((await listAppVersions(app.id, owner)).length, before + 1, 'a real rename snapshots once');
});

// ---------------------------------------------------------------- move: folder --

test('moveApp: sets the folder (edit-scoped), normalises the path, and is visible in the scope', async () => {
  __resetAppsCache();
  const app = await createApp(owner, { name: 'Foldered', template: 'service' });
  assert.equal(app.folder, '/', 'a fresh app lives at the root');

  const moved = await moveApp(app.id, owner, 'reports/q3');
  assert.equal(moved.folder, '/reports/q3', 'folder normalised to a leading-slash path');
  // Re-read through the governed path — the folder persists.
  const back = await getAppForUser(app.id, owner);
  assert.equal(back.folder, '/reports/q3');

  // A non-owner non-admin cannot move a Personal app.
  const stranger = { id: 'nobody', name: 'Nobody', domains: ['sales'], role: 'creator' as const };
  await assert.rejects(
    () => moveApp(app.id, stranger, '/elsewhere'),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('repoHtmlUrl: the EXTERNAL browsable URL, not Forgejo’s in-cluster html_url (the repo-404 fix)', () => {
  const base = config.forgejoConsoleUrl.replace(/\/+$/, '');
  // Built from the external console URL + full name — never the internal ROOT_URL.
  assert.equal(repoHtmlUrl('gitea_admin/my-app'), `${base}/gitea_admin/my-app`);
  // No double slash when the full name carries a leading slash.
  assert.equal(repoHtmlUrl('/gitea_admin/my-app'), `${base}/gitea_admin/my-app`);
  // A cluster-internal host is NEVER produced from a well-formed full name.
  assert.doesNotMatch(repoHtmlUrl('gitea_admin/my-app'), /forgejo-http:3000/);
  // Empty full name degrades to the base console URL, not a dangling slash.
  assert.equal(repoHtmlUrl(''), base);
});

test('dirListing: immediate children only, dirs before files, deduped', () => {
  const files = [
    'src/App.tsx',
    'src/epics/README.md',
    'src/epics/sales/lead/Lead.tsx',
    'src/epics/sales/general/util.ts',
    'src/template/shell.tsx',
    'README.md',
  ];
  // Root: top-level files + top-level dirs, dirs first.
  const root = dirListing(files, '');
  assert.deepEqual(
    root.map((e) => `${e.type}:${e.name}`),
    ['dir:src', 'file:README.md'],
  );
  // A directory: its direct entries, with subdirs as `dir` (not recursed).
  const epics = dirListing(files, 'src/epics');
  assert.deepEqual(
    epics.map((e) => `${e.type}:${e.name}`),
    ['dir:sales', 'file:README.md'],
  );
  assert.equal(epics.find((e) => e.name === 'sales')?.path, 'src/epics/sales');
  // A trailing slash resolves to the same directory.
  assert.deepEqual(dirListing(files, 'src/epics/'), epics);
  // A path matching nothing → empty (the tool turns this into a 404).
  assert.deepEqual(dirListing(files, 'src/nope'), []);
  // A deeper dir with only files.
  assert.deepEqual(
    dirListing(files, 'src/epics/sales/lead').map((e) => `${e.type}:${e.name}`),
    ['file:Lead.tsx'],
  );
});

// -------------------------------------------- repo-delete guard (shared slug) --

test('repoSharedByLiveApp: another ACTIVE app on the same slug blocks the delete', () => {
  const self = appStub('app_new', 'northpeak-products', 'active');
  const peer = appStub('app_old', 'northpeak-products', 'active');
  assert.equal(
    repoSharedByLiveApp(self, [self, peer]),
    'app_old',
    'a live peer sharing the slug is returned (delete must be skipped)',
  );
});

test('repoSharedByLiveApp: self is excluded and no peer → null (delete proceeds)', () => {
  const self = appStub('app_solo', 'solo-app', 'active');
  assert.equal(repoSharedByLiveApp(self, [self]), null, 'an app never blocks its own delete');
  const other = appStub('app_other', 'a-different-slug', 'active');
  assert.equal(repoSharedByLiveApp(self, [self, other]), null, 'a different slug does not block');
});

test('repoSharedByLiveApp: an ARCHIVED peer on the same slug does NOT block', () => {
  const self = appStub('app_new', 'shared-slug', 'active');
  const archived = appStub('app_arch', 'shared-slug', 'archived');
  assert.equal(
    repoSharedByLiveApp(self, [self, archived]),
    null,
    'archived peers do not veto a delete — only live apps count',
  );
});

// -------------------------------------------- earned built-ness (phantom fix) --

const epicsWithStory = (status: 'todo' | 'building' | 'done'): AppEpic[] => [
  {
    id: 'e1',
    title: 'Admin',
    stories: [
      { id: 's1', title: 'Tenant mgmt', asA: 'a', iWant: 'b', soThat: 'c', acceptance: 'ok', status },
    ],
  } as unknown as AppEpic,
];

test('patchAppDesign REFUSES to flip a story to done on an app with NO committed code', async () => {
  __resetAppsCache();
  const owner = { id: 'eb1', name: 'EB1', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'PhantomGuard', template: 'sovereign-app' });
  // No real commit: offline scaffold, empty seeded repo, no snapshot pages.
  assert.notEqual(app.pipeline.forgejo, 'ok');
  const after = await patchAppDesign(app.id, owner, { epics: epicsWithStory('done') });
  assert.equal(after.epics?.[0].stories[0].status, 'todo', 'a self-reported done is forced back to todo — built-ness is earned');
});

test('patchAppDesign KEEPS done when the app has a real commit (forgejo ok)', async () => {
  __resetAppsCache();
  const owner = { id: 'eb2', name: 'EB2', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'RealCommit', template: 'sovereign-app' });
  app.pipeline.forgejo = 'ok'; // a real repo with a landed commit
  const after = await patchAppDesign(app.id, owner, { epics: epicsWithStory('done') });
  assert.equal(after.epics?.[0].stories[0].status, 'done', 'a genuinely-committed app trusts the earned status');
});

test('reconcileBuiltStatus demotes phantom done/building when nothing is committed', async () => {
  __resetAppsCache();
  const owner = { id: 'eb3', name: 'EB3', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'HealMe', template: 'sovereign-app' });
  // Simulate the live lie: status already persisted done, but no repo/commit exists.
  app.epics = epicsWithStory('done');
  const r = reconcileBuiltStatus(app);
  assert.equal(r.demoted, 1);
  assert.equal(app.epics?.[0].stories[0].status, 'todo', 'the phantom-built story self-corrects to its true state');
});

test('reconcileBuiltStatus is a NO-OP when the committed snapshot has story pages', async () => {
  __resetAppsCache();
  const owner = { id: 'eb4', name: 'EB4', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'TrulyBuilt', template: 'sovereign-app' });
  app.epics = epicsWithStory('done');
  // A real committed page under the story-folder convention → built-ness is genuine.
  snapshotFiles(app.id, [{ path: 'src/epics/admin/tenant/Page.tsx', content: 'export default () => null;' }]);
  const r = reconcileBuiltStatus(app);
  assert.equal(r.demoted, 0, 'a real committed page is left alone');
  assert.equal(app.epics?.[0].stories[0].status, 'done');
});

// ------------------------------------------------- grants → runtime OPA profile --

test('grants recompile: patching grants adds the data-plane tools to the app OPA profile', async () => {
  __resetAppsCache();
  const owner = { id: 'gr1', name: 'GR1', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'GrantsApp', template: 'sovereign-app' });

  // Baseline: the app's OPA profile carries its TEMPLATE tools; no data-plane grant tools yet.
  const before = exposedConnectionTools(app.mcpPrincipal);
  assert.equal(before.includes('query_data'), false, 'no granted data tool before any grant');

  // Patch a DATA + KNOWLEDGE grant → recompile must fold in their data-plane tools.
  await patchAppDesign(app.id, owner, {
    grants: {
      connections: [],
      data: [{ id: 'ds_x', access: 'read-only' }],
      knowledge: [{ id: 'wf_y', access: 'read-only' }],
      files: [],
      metrics: [],
    },
  });
  const after = exposedConnectionTools(app.mcpPrincipal);
  assert.ok(after.includes('query_data'), 'granted data ⇒ query_data now exposed');
  assert.ok(after.includes('get_dataset'), 'discovery companion exposed');
  assert.ok(after.includes('search_knowledge'), 'granted knowledge ⇒ search_knowledge exposed');
  // Template tools remain the baseline surface (grants only ADD).
  assert.ok(after.length >= before.length, 'grants add to, never remove, the template surface');
});

test('grants recompile: clearing grants fails closed — data-plane tools drop back to template default', async () => {
  __resetAppsCache();
  const owner = { id: 'gr2', name: 'GR2', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'GrantsApp2', template: 'sovereign-app' });
  await patchAppDesign(app.id, owner, {
    grants: { connections: [], data: [{ id: 'ds_z', access: 'read-only' }], knowledge: [], files: [], metrics: [] },
  });
  assert.ok(exposedConnectionTools(app.mcpPrincipal).includes('query_data'), 'granted');
  // Revoke every grant → recompile removes the data-plane tools (fail-closed).
  await patchAppDesign(app.id, owner, {
    grants: { connections: [], data: [], knowledge: [], files: [], metrics: [] },
  });
  assert.equal(
    exposedConnectionTools(app.mcpPrincipal).includes('query_data'),
    false,
    'revoking the grant removes runtime access',
  );
});

// --------------------------------------------------------------- Membership --

test('membership: normalizeAppMembers is deterministic, drops junk, excludes owner', () => {
  const owner = 'ownerX';
  const out = normalizeAppMembers(
    [
      { id: 'zeb', role: 'member' },
      { id: 'ann', role: 'admin' },
      { id: 'ownerX', role: 'admin' }, // owner is implicit — dropped
      { id: 'ann', role: 'member' }, // dup — first role wins
      { id: 'bad', role: 'nope' }, // unknown role — dropped
      { role: 'member' }, // no id — dropped
      null,
      'x',
    ] as unknown,
    owner,
  );
  assert.deepEqual(out, [
    { id: 'ann', role: 'admin' },
    { id: 'zeb', role: 'member' },
  ], 'sorted by id, junk removed, owner excluded, dedup first-wins');
  // Absent/invalid list ⇒ owner-only ([]) — the nil-safe default old records rely on.
  assert.deepEqual(normalizeAppMembers(undefined, owner), []);
  assert.deepEqual(normalizeAppMembers({} as unknown, owner), []);
});

test('membership: a fresh app defaults to OWNER-ONLY (no other accounts appear)', async () => {
  __resetAppsCache();
  __resetUsers();
  const owner = { id: 'own1', name: 'Owner One', domains: ['sales'], role: 'builder' as const };
  await createUser({ id: 'own1', name: 'Owner One', password: 'x', domains: ['sales'], role: 'builder', email: 'own1@example.com' });
  const app = await createApp(owner, { name: 'Members Default', template: 'sovereign-app' });
  assert.deepEqual(app.members, [], 'no explicit members on create');
  const { members, canManage } = await listAppMembers(app.id, owner);
  assert.equal(members.length, 1, 'only the owner is listed by default');
  assert.equal(members[0].id, 'own1');
  assert.equal(members[0].isOwner, true);
  assert.equal(members[0].role, 'admin', 'owner is the implicit admin');
  assert.equal(canManage, true, 'owner may manage membership');
});

test('membership: old records with no members list are nil-safe (owner-only after hydrate)', async () => {
  __resetAppsCache();
  __resetUsers();
  const owner = { id: 'own2', name: 'Owner Two', domains: ['sales'], role: 'admin' as const };
  await createUser({ id: 'own2', name: 'Owner Two', password: 'x', domains: ['sales'], role: 'admin', email: 'own2@example.com' });
  const app = await createApp(owner, { name: 'Legacy App', template: 'sovereign-app' });
  // Simulate a pre-membership persisted record.
  (app as unknown as { members?: unknown }).members = undefined;
  const { members } = await listAppMembers(app.id, owner);
  assert.equal(members.length, 1, 'absent list ⇒ owner-only, never a crash');
  assert.equal(members[0].isOwner, true);
});

test('membership: an app admin can add + remove a named member; non-admin is denied', async () => {
  __resetAppsCache();
  __resetUsers();
  const owner = { id: 'own3', name: 'Owner Three', domains: ['sales'], role: 'builder' as const };
  const outsider = { id: 'out3', name: 'Outsider', domains: ['sales'], role: 'builder' as const };
  await createUser({ id: 'own3', name: 'Owner Three', password: 'x', domains: ['sales'], role: 'builder', email: 'own3@example.com' });
  await createUser({ id: 'out3', name: 'Outsider', password: 'x', domains: ['sales'], role: 'builder', email: 'out3@example.com' });
  await createUser({ id: 'mem3', name: 'New Member', password: 'x', domains: ['sales'], role: 'creator', email: 'mem3@example.com' });
  const app = await createApp(owner, { name: 'Add Remove', template: 'sovereign-app' });

  // Owner adds a member.
  await addAppMember(app.id, owner, 'mem3', 'member');
  let view = await listAppMembers(app.id, owner);
  assert.equal(view.members.length, 2, 'owner + the added member');
  assert.ok(view.members.some((m) => m.id === 'mem3' && m.role === 'member' && !m.isOwner));

  // A non-owner, non-admin (Personal app) may NOT add.
  await assert.rejects(
    () => addAppMember(app.id, outsider, 'out3', 'member'),
    (e: unknown) => (e as { status?: number }).status === 403,
    'a non-admin cannot manage membership',
  );

  // Adding an unknown OS user fails 404 (must be a real account).
  await assert.rejects(
    () => addAppMember(app.id, owner, 'ghost', 'member'),
    (e: unknown) => (e as { status?: number }).status === 404,
    'cannot add a non-existent OS user',
  );

  // Owner removes the member.
  await removeAppMember(app.id, owner, 'mem3');
  view = await listAppMembers(app.id, owner);
  assert.equal(view.members.length, 1, 'back to owner-only after removal');

  // The owner can never be removed (the app cannot go admin-less).
  await assert.rejects(
    () => removeAppMember(app.id, owner, 'own3'),
    (e: unknown) => (e as { status?: number }).status === 400,
    'the owner cannot be removed',
  );
});

test('membership: getAppBySlugForUser resolves the deployed app for a viewer, honours visibility', async () => {
  __resetAppsCache();
  __resetUsers();
  const owner = { id: 'own4', name: 'Owner Four', domains: ['sales'], role: 'builder' as const };
  const stranger = { id: 'str4', name: 'Stranger', domains: ['ops'], role: 'builder' as const };
  await createUser({ id: 'own4', name: 'Owner Four', password: 'x', domains: ['sales'], role: 'builder', email: 'own4@example.com' });
  const app = await createApp(owner, { name: 'Slug App', template: 'sovereign-app' });

  const bySlug = await getAppBySlugForUser(app.slug, owner);
  assert.ok(bySlug && bySlug.id === app.id, 'owner resolves their app by slug');
  // Personal app: a stranger in another domain sees nothing.
  const denied = await getAppBySlugForUser(app.slug, stranger);
  assert.equal(denied, null, 'a non-visible app is not resolvable by slug');
  // Unknown slug ⇒ null (a deleted deploy degrades honestly).
  assert.equal(await getAppBySlugForUser('no-such-slug', owner), null);
});

test('Phase B flag OFF: refreshBuildStage says WHY honestly and leaves Actions authoritative', async () => {
  // SOFTWARE_BUILD_SERVICE is unset in this file's process → the build service is OFF.
  __resetAppsCache();
  const { refreshBuildStage } = await import('./apps.ts');
  const { BUILD_SERVICE_OFF_NOTE } = await import('./build-service.ts');
  const app = await createApp(user, { name: 'Off Flag App', template: 'vite-os' });
  const before = app.pipeline.harbor;
  const out = await refreshBuildStage(app);
  assert.ok(out, 'the OFF state is still reported, never silent');
  assert.equal(out.status, before, 'the stage is untouched — Forgejo Actions stays authoritative');
  assert.equal(out.note, BUILD_SERVICE_OFF_NOTE, 'the note states the flag/RBAC cause + the Actions fallback');
  assert.equal(app.runImageDigest, undefined, 'no digest is ever pinned while the service is off');
});
