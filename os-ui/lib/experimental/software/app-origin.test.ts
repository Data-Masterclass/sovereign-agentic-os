/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for the LEAST-PRIVILEGE app-origin cap (app-origin.ts):
 *   • appSlugFromRequest — deployed-app origin, OS origin, same-origin runtime referer,
 *     and garbage all resolve correctly (the non-app case returns null → OS UI untouched).
 *   • checkAppGrant / grantedIdSet — granted, not-granted, and unknown-slug (fail closed).
 *
 * The apps base domain + OS public URL come from `config`, which reads env at import
 * time — so we SET them BEFORE importing anything that pulls in config.
 */

process.env.OS_APPS_DOMAIN = 'apps.example.com';
process.env.OS_PUBLIC_URL = 'https://os.example.com';

// Force the in-process app cache offline (empty Map) + a controllable auth identity,
// mirroring app-records-route.test.ts so createApp/getAppBySlugInternal work in-test.
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

const { appSlugFromRequest, checkAppGrant, grantedIdSet } = await import('./app-origin.ts');
const { createApp, writeThroughApp, __resetAppsCache } = await import('./apps.ts');
// Real artifacts registry: seed a dataset so getArtifact resolves its name (0.6.97
// friendly-denial), and reset it between tests. No module mock — other importers of
// artifacts (e.g. apps.ts) must keep their real exports.
const { createArtifact, __resetArtifactsCache } = await import('@/lib/core/artifacts');

beforeEach(() => {
  __resetAppsCache();
  __resetArtifactsCache();
});

const reqWith = (headers: Record<string, string>) => new Request('http://os.example.com/api/data/datasets', { headers });

// ── appSlugFromRequest ──────────────────────────────────────────────────────────

test('a deployed-app cross-origin Origin resolves to the app slug (first host label)', () => {
  const req = reqWith({ origin: 'https://northpeak.sales.apps.example.com' });
  assert.equal(appSlugFromRequest(req), 'northpeak');
});

test('the app slug can also come from a cross-origin Referer', () => {
  const req = reqWith({ referer: 'https://northpeak.sales.apps.example.com/some/path' });
  assert.equal(appSlugFromRequest(req), 'northpeak');
});

test('an OS-origin request is NOT an app (null) — the OS UI is untouched', () => {
  const req = reqWith({ origin: 'https://os.example.com' });
  assert.equal(appSlugFromRequest(req), null);
});

test('a same-origin OS request with no Origin/Referer is not an app (null)', () => {
  assert.equal(appSlugFromRequest(reqWith({})), null);
});

test('a same-origin runtime-served app is attributed via the /api/apps/runtime/<slug> referer', () => {
  const req = reqWith({ referer: 'https://os.example.com/api/apps/runtime/northpeak?x=1' });
  assert.equal(appSlugFromRequest(req), 'northpeak');
});

test('a runtime referer under the OS origin wins even with no app Origin', () => {
  const req = reqWith({ origin: 'https://os.example.com', referer: 'https://os.example.com/api/apps/runtime/beta-app' });
  assert.equal(appSlugFromRequest(req), 'beta-app');
});

test('garbage / arbitrary attacker origins are not app origins (null)', () => {
  assert.equal(appSlugFromRequest(reqWith({ origin: 'not a url' })), null);
  assert.equal(appSlugFromRequest(reqWith({ origin: 'https://evil.example.org' })), null);
  // A host that merely CONTAINS the apps domain as a substring is not under it.
  assert.equal(appSlugFromRequest(reqWith({ origin: 'https://apps.example.com.evil.org' })), null);
  // The bare apps domain is not a per-app host.
  assert.equal(appSlugFromRequest(reqWith({ origin: 'https://apps.example.com' })), null);
});

// ── checkAppGrant / grantedIdSet ─────────────────────────────────────────────────

/** Seed an app owned by ACTING with a single dataset grant. */
async function seedGrantedApp() {
  ACTING = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  const app = await createApp(ACTING, { name: 'Northpeak Products', template: 'sovereign-app' });
  app.grants.data = [{ id: 'ds_zpco1s6n7y', access: 'read-only' }];
  writeThroughApp(app);
  return app;
}

test('checkAppGrant: a granted dataset is allowed', async () => {
  const app = await seedGrantedApp();
  const out = await checkAppGrant(app.slug, 'data', 'ds_zpco1s6n7y');
  assert.equal(out.allowed, true);
});

// CASE 2 (deleted/nonexistent): a referenced dataset that getArtifact can't resolve is
// treated as GONE — the denial says "no longer exists" + rebuild/restore, and must NOT
// tell the user to grant it (they can't — it's deleted). Fail-soft: the bare id, no throw.
test('checkAppGrant: a NONEXISTENT dataset is denied as deleted (rebuild/restore, not grant)', async () => {
  const app = await seedGrantedApp();
  const out = await checkAppGrant(app.slug, 'data', 'ds_not_granted');
  assert.equal(out.allowed, false);
  assert.match(out.reason, /ds_not_granted/);
  assert.match(out.reason, /no longer exists|deleted/i);
  assert.match(out.reason, /rebuild|restore/i);
  // Not a "grant it" message, and no «…» name wrapper (unknown id).
  assert.doesNotMatch(out.reason, /Software tab/);
  assert.doesNotMatch(out.reason, /«/);
});

// CASE 1 (exists, ungranted): the denial NAMES the real dataset — «Service Centers»
// (ds_…) — and points at the grant flow (the owner's "must name the real dataset" ask).
test('checkAppGrant: an ungranted EXISTING dataset is denied by NAME + grant flow', async () => {
  const app = await seedGrantedApp();
  const seeder = { id: 'own', name: 'Owner', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' };
  const ds = await createArtifact(seeder as never, { type: 'dataset', name: 'Service Centers' });
  const out = await checkAppGrant(app.slug, 'data', ds.id);
  assert.equal(out.allowed, false);
  assert.match(out.reason, new RegExp(`«Service Centers» \\(${ds.id}\\)`));
  assert.match(out.reason, /not granted/i);
  assert.match(out.reason, /Software tab/);
});

test('checkAppGrant: an UNKNOWN slug from an app origin fails CLOSED (denied)', async () => {
  const out = await checkAppGrant('ghost-app', 'data', 'ds_zpco1s6n7y');
  assert.equal(out.allowed, false);
  assert.match(out.reason, /not a known app/i);
});

test('grantedIdSet: returns the granted ids for a kind, empty for an unknown slug', async () => {
  const app = await seedGrantedApp();
  const set = await grantedIdSet(app.slug, 'data');
  assert.ok(set.has('ds_zpco1s6n7y'));
  assert.equal(set.size, 1);
  const empty = await grantedIdSet('ghost-app', 'data');
  assert.equal(empty.size, 0); // fail closed
});
