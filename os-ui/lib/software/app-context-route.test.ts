/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route tests for the app-scoped GET /api/apps/by-slug/[slug]/context — the HONEST
 * "Granted context" surface. It proves:
 *   1. ENTRY — an app not visible to the caller is 404 (never leaks its existence).
 *   2. Returns ONLY the app's own grants (not everything the user can see).
 *   3. An artifact whose name can't be resolved falls back to `name: id` (honest,
 *      never silently dropped).
 *   4. Zero grants → an empty items list.
 *
 * Pattern mirrors app-records-route.test.ts (offline app cache + mocked auth).
 */

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

const { createApp, writeThroughApp, __resetAppsCache } = await import('./apps.ts');

beforeEach(() => {
  __resetAppsCache();
});

async function loadRoute() {
  return import(`../../app/api/apps/by-slug/[slug]/context/route.ts?${Math.random()}`);
}

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const get = () => new Request('http://x/context');

/** Owner + their app, with one dataset grant that won't resolve to a name in-test. */
async function seedApp() {
  const owner = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  ACTING = owner;
  const app = await createApp(owner, { name: 'Northpeak Products', template: 'sovereign-app' });
  app.grants.data = [{ id: 'ds_zpco1s6n7y', access: 'read-only' }];
  writeThroughApp(app);
  return app;
}

test('context: an app not visible to the caller is 404 (entry-gated)', async () => {
  const app = await seedApp();
  ACTING = { id: 'str', name: 'Stranger', domains: ['ops'], role: 'builder' };
  const route = await loadRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 404);
});

test('context: returns ONLY the app grants, name-resolved (id fallback when unresolved)', async () => {
  const app = await seedApp();
  const route = await loadRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1, 'only the app grant, not everything the user can see');
  assert.equal(body.items[0].kind, 'data');
  assert.equal(body.items[0].id, 'ds_zpco1s6n7y');
  assert.equal(body.items[0].access, 'read-only');
  // No registry entry for this id in-test ⇒ honest id fallback (not dropped).
  assert.equal(body.items[0].name, 'ds_zpco1s6n7y');
});

test('context: an app with zero grants returns an empty items list', async () => {
  const owner = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  ACTING = owner;
  const app = await createApp(owner, { name: 'Fresh App', template: 'sovereign-app' });
  const route = await loadRoute();
  const res = await route.GET(get(), ctx(app.slug));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items, []);
});
