/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route tests for the app's OWN records — the SECOND door onto the same governed
 * record store the MCP tools reach (one store, two doors). They run AS the signed-in
 * user, keyed by the app slug, and prove the two gates:
 *
 *   1. ENTRY  — an app not visible to the caller is 404 (never leaks its existence).
 *   2. ENVELOPE (writes) — add/export need the tool in the app's APPROVED deploy
 *      envelope; a missing approval is 403 with an honest, governance-naming reason.
 *   3. Reads (list/get) and an ENVELOPE-approved write reach the shared executor,
 *      which routes the four record tools to the durable OS-side app-records store
 *      (`source:'os-records-store'`) — so an add PERSISTS and a following list returns it.
 *
 * Pattern mirrors lib/governance/approvals-route.test.ts: stub fetch to force the
 * offline in-process app cache, mock @/lib/core/auth, cache-busted route imports.
 */

// Stub fetch BEFORE importing apps.ts so OpenSearch + k8s pings fail fast → the app
// cache is an empty in-process Map and the runner reads 'offline' (seed execution).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) {
        const e = new Error('Not authenticated') as Error & { status?: number };
        e.status = 401;
        throw e;
      }
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});

const { createApp, __resetAppsCache, writeThroughApp } = await import('./apps.ts');
const { createUser, __resetUsers } = await import('@/lib/platform-admin/users');
const { __resetAppRecordsCache } = await import('./app-records-store.ts');

beforeEach(() => {
  __resetAppsCache();
  __resetUsers();
  __resetAppRecordsCache();
});

async function loadListRoute() {
  return import(`../../app/api/apps/by-slug/[slug]/records/route.ts?${Math.random()}`);
}
async function loadGetRoute() {
  return import(`../../app/api/apps/by-slug/[slug]/records/[id]/route.ts?${Math.random()}`);
}
async function loadExportRoute() {
  return import(`../../app/api/apps/by-slug/[slug]/records/export/route.ts?${Math.random()}`);
}

const ctx = (slug: string, id?: string) => ({
  params: Promise.resolve(id !== undefined ? { slug, id } : { slug }),
});
const get = () => new Request('http://x/records');
const post = (body: unknown = {}) =>
  new Request('http://x/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Create an owner + their app; return the app. */
async function seedApp(role = 'builder', domains = ['sales']) {
  const owner = { id: 'own', name: 'Owner', domains, role };
  await createUser({ id: 'own', name: 'Owner', password: 'x', domains, role, email: 'own@example.com' });
  ACTING = owner;
  const app = await createApp(owner, { name: 'Northpeak Products', template: 'sovereign-app' });
  return app;
}

// 1. ENTRY GATE — an app the caller cannot see is 404 (a stranger in another domain).
test('records list: an app not visible to the caller is 404 (entry-gated)', async () => {
  const app = await seedApp();
  ACTING = { id: 'str', name: 'Stranger', domains: ['ops'], role: 'builder' };
  const route = await loadListRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /not found/i);
});

// 2a. DEFAULT (0.6.97) — the app's OWN record writes work out of the box, no
//     approved envelope needed (the owner's "automatic read+write by default" rule).
test('records add: a FRESH app (no envelope) can write its own records by default ⇒ 200', async () => {
  const app = await seedApp(); // fresh app: deploy.approved is null
  assert.equal(app.deploy.approved, null, 'a fresh app has no approved envelope');
  const route = await loadListRoute();
  const res = await route.POST(post({ record: { name: 'Widget' } }), ctx(app.slug));
  assert.equal(res.status, 200, 'the app\'s own record write is auto-approved by default');
  const { result } = await res.json();
  assert.equal(result.source, 'os-records-store');
  assert.equal(result.added.name, 'Widget');
});

// 2b. REVOCABLE — once the owner REVOKES the default, a write with no approved
//     envelope is 403 again, honestly naming the governance path.
test('records add: REVOKED default + no approved envelope ⇒ 403 naming the governance path', async () => {
  const app = await seedApp();
  app.recordWritesRevoked = true; // owner turns the default off
  writeThroughApp(app);
  const route = await loadListRoute();
  const res = await route.POST(post({ record: { name: 'Widget' } }), ctx(app.slug));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /add_record/);
  assert.match(body.error, /approved deploy envelope|REVOKED/);
  assert.match(body.error, /request_deploy|Builder|un-revoke/);
});

test('records export: REVOKED default + no approved export_records ⇒ 403 (envelope-gated write)', async () => {
  const app = await seedApp();
  app.recordWritesRevoked = true;
  writeThroughApp(app);
  const route = await loadExportRoute();
  const res = await route.POST(post(), ctx(app.slug));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /export_records/);
});

// 3. HAPPY PATHS — reads always-on; the record tools resolve to the durable
//    OS-side app-records store, and an approved add PERSISTS.
test('records list: entry-visible owner gets the OS-side store result (empty to start)', async () => {
  const app = await seedApp();
  const route = await loadListRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.source, 'os-records-store', 'record reads hit the durable OS-side store');
  assert.ok(Array.isArray(result.items), 'list returns items');
  assert.equal(result.items.length, 0, 'a fresh app has no records');
});

test('records get: reads are always-on and hit the OS-side store (missing id ⇒ null)', async () => {
  const app = await seedApp();
  const route = await loadGetRoute();
  const res = await route.GET(get(), ctx(app.slug, 'r1'));
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.source, 'os-records-store');
  assert.equal(result.item, null, 'an unknown id is null, not fabricated');
});

test('records add: WITH add_record in the envelope ⇒ 200 AND the record PERSISTS (add → list)', async () => {
  const app = await seedApp();
  // Approve the write envelope the way a Builder deploy would (add_record enabled live).
  app.deploy.approved = { writeTools: ['add_record'], connections: [], data: [], knowledge: [], footprint: { cpu: '250m', memory: '256Mi', estMonthlyUsd: 5 } };
  writeThroughApp(app);
  const route = await loadListRoute();
  const res = await route.POST(post({ record: { name: 'Widget', amount: 12 } }), ctx(app.slug));
  assert.equal(res.status, 200, 'an envelope-approved write is allowed');
  const { result } = await res.json();
  assert.equal(result.source, 'os-records-store', 'the write lands in the durable OS-side store');
  assert.ok(result.added, 'the add executor returns the added record');
  assert.equal(result.added.name, 'Widget');

  // Durability: a fresh list returns the record just written.
  const listRes = await route.GET(get(), ctx(app.slug));
  const listed = (await listRes.json()).result;
  assert.equal(listed.items.length, 1, 'the added record persists');
  assert.equal(listed.items[0].name, 'Widget');
});

test('records add: anonymous caller is 401 (the session gate)', async () => {
  const app = await seedApp();
  ACTING = null; // no session
  const route = await loadListRoute();
  const res = await route.POST(post({ record: {} }), ctx(app.slug));
  assert.equal(res.status, 401);
});
