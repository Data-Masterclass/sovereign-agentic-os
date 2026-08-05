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
 *      which — with no live runner in-test — returns honestly-labelled demo-seed.
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

beforeEach(() => {
  __resetAppsCache();
  __resetUsers();
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

// 2. ENVELOPE GATE — a write with no approved envelope is 403, honestly.
test('records add: no approved add_record in the envelope ⇒ 403 naming the governance path', async () => {
  const app = await seedApp(); // fresh app: deploy.approved is null
  assert.equal(app.deploy.approved, null, 'a fresh app has no approved envelope');
  const route = await loadListRoute();
  const res = await route.POST(post({ record: { name: 'Widget' } }), ctx(app.slug));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /add_record/);
  assert.match(body.error, /approved deploy envelope/);
  assert.match(body.error, /request_deploy|Builder/);
});

test('records export: no approved export_records ⇒ 403 (envelope-gated write)', async () => {
  const app = await seedApp();
  const route = await loadExportRoute();
  const res = await route.POST(post(), ctx(app.slug));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /export_records/);
});

// 3. HAPPY PATHS — reads always-on; an envelope-approved write reaches the executor.
test('records list: entry-visible owner gets the seed result (no live runner)', async () => {
  const app = await seedApp();
  const route = await loadListRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.source, 'demo-seed', 'no live runner ⇒ honestly-labelled seed');
  assert.ok(Array.isArray(result.items), 'list returns items');
});

test('records get: reads are always-on and return the seeded item shape', async () => {
  const app = await seedApp();
  const route = await loadGetRoute();
  const res = await route.GET(get(), ctx(app.slug, 'r1'));
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.source, 'demo-seed');
  assert.ok('item' in result, 'get returns an item field');
});

test('records add: WITH add_record in the approved envelope ⇒ 200, executor runs', async () => {
  const app = await seedApp();
  // Approve the write envelope the way a Builder deploy would (add_record enabled live).
  app.deploy.approved = { writeTools: ['add_record'], connections: [], data: [], knowledge: [], footprint: { cpu: '250m', memory: '256Mi', estMonthlyUsd: 5 } };
  writeThroughApp(app);
  const route = await loadListRoute();
  const res = await route.POST(post({ record: { name: 'Widget', amount: 12 } }), ctx(app.slug));
  assert.equal(res.status, 200, 'an envelope-approved write is allowed');
  const { result } = await res.json();
  assert.equal(result.source, 'demo-seed', 'no live runner ⇒ seed, but the write door was open');
  assert.ok(result.added, 'the add executor returns the added record');
});

test('records add: anonymous caller is 401 (the session gate)', async () => {
  const app = await seedApp();
  ACTING = null; // no session
  const route = await loadListRoute();
  const res = await route.POST(post({ record: {} }), ctx(app.slug));
  assert.equal(res.status, 401);
});
