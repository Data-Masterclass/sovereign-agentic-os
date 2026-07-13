/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Lifecycle tests for the canonical Platform Admin → Users & Access surface:
 * invite-with-password (the created user can AUTHENTICATE), server-side strength
 * rejection, admin password reset, offboard with artifact reassignment, and the
 * self / last-active-admin guards.
 *
 * Drives the real route handlers end-to-end with only auth + platform-admin ctx,
 * _compile and audit mocked. Mirrors tenant-users-edit.test.ts (the module-mock
 * setup, next/server shim and per-test route re-import).
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../core/password.ts';
import { __resetUsers } from './users.ts';

// ---------------------------------------------------------------------------
// Stubs (mirror tenant-users-edit.test.ts)
// ---------------------------------------------------------------------------
type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
let activeFetch: Stub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) =>
  activeFetch ? activeFetch(url, init) : realFetch(url as string, init)) as typeof fetch;

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function openSearchStub() {
  const store = new Map<string, Record<string, unknown>>();
  const stub: Stub = async (url, init = {}) => {
    try { new URL(url); } catch { return jsonRes({}, 404); }
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path.endsWith('/_count')) return jsonRes({ count: store.size });
    if (path.endsWith('/_search'))
      return jsonRes({ hits: { hits: [...store.values()].map((_source) => ({ _source })) } });
    const m = path.match(/\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') { store.set(id, JSON.parse(init.body ?? '{}')); return jsonRes({ result: 'created' }); }
      if (method === 'DELETE') { store.delete(id); return jsonRes({ result: 'deleted' }); }
    }
    return jsonRes({}, 404);
  };
  return { store, stub };
}

type MockAdminCtx = { id: string; role: string; domains: string[] };
let ACTING_ADMIN: MockAdminCtx = { id: 'ada', role: 'admin', domains: ['platform'] };

mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => ({ user: ACTING_ADMIN, tenant: { id: 'test-tenant' }, opa: 'opa-allow' }),
    fail: (e: unknown) => {
      const status = (e as { status?: number })?.status ?? 500;
      return { status, async json() { return { error: (e as Error).message }; } };
    },
  },
});
mock.module('@/app/api/platform-admin/_compile', { namedExports: { recompile: async () => ({ publish: 'skipped' }) } });
mock.module('@/lib/platform-admin/audit', { namedExports: { audit: () => undefined } });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STRONG = 'Tr0ub4dour&3-test';
let routeTag = 0;

/** Fresh stores + a seeded admin `ada`. Returns the users module + route modules. */
async function freshEnv() {
  routeTag += 1;
  const { stub } = openSearchStub();
  activeFetch = stub;
  ACTING_ADMIN = { id: 'ada', role: 'admin', domains: ['platform'] };

  __resetUsers();
  const users = await import('./users.ts');
  await users.setupAdmin({
    bootstrapId: 'admin',
    username: 'ada',
    email: 'ada@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });

  const listRoute = await import(`../../app/api/platform-admin/access/route.ts?t=${routeTag}`);
  const idRoute = await import(`../../app/api/platform-admin/access/[id]/route.ts?t=${routeTag}`);
  return { users, listRoute, idRoute };
}

function post(listRoute: { POST: (r: Request) => Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> }, body: Record<string, unknown>) {
  const req = new Request('http://localhost/api/platform-admin/access', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return listRoute.POST(req);
}
function patch(idRoute: { PATCH: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> }, id: string, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/platform-admin/access/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return idRoute.PATCH(req, { params: Promise.resolve({ id }) });
}
function del(idRoute: { DELETE: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> }, id: string, body: Record<string, unknown> = {}) {
  const req = new Request(`http://localhost/api/platform-admin/access/${id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return idRoute.DELETE(req, { params: Promise.resolve({ id }) });
}

// ---------------------------------------------------------------------------
// 1. Invite with an admin-set password → the user can AUTHENTICATE (the unblock)
// ---------------------------------------------------------------------------
test('invite with admin-set password: created user authenticates with it', async () => {
  const { users, listRoute } = await freshEnv();
  const res = await post(listRoute, { id: 'kim@example.com', name: 'Kim', role: 'creator', domains: ['sales'], password: STRONG });
  const body = await res.json();
  assert.equal(res.status, 201, `expected 201 but got ${res.status}: ${JSON.stringify(body)}`);
  const authed = await users.authenticate('kim@example.com', STRONG);
  assert.ok(authed, 'the created user authenticates with the admin-set password');
  assert.equal(authed?.id, 'kim@example.com');
  activeFetch = null;
});

test('invite with a blank password generates one and returns it once (generated=true)', async () => {
  const { users, listRoute } = await freshEnv();
  const res = await post(listRoute, { id: 'lee@example.com', name: 'Lee', role: 'creator', domains: ['sales'] });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.generated, true, 'server flags the password as generated');
  assert.ok(typeof body.tempPassword === 'string' && body.tempPassword.length >= 12, 'a strong password is surfaced once');
  const authed = await users.authenticate('lee@example.com', body.tempPassword as string);
  assert.ok(authed, 'generated password authenticates');
  activeFetch = null;
});

// ---------------------------------------------------------------------------
// 2. Empty/weak password rejected server-side (400)
// ---------------------------------------------------------------------------
test('invite with a weak password is rejected with 400', async () => {
  const { listRoute } = await freshEnv();
  const res = await post(listRoute, { id: 'weak@example.com', name: 'W', role: 'creator', domains: ['sales'], password: 'short' });
  assert.equal(res.status, 400, 'weak password blocked server-side');
  activeFetch = null;
});

// ---------------------------------------------------------------------------
// 3. Admin reset password works and the new password authenticates
// ---------------------------------------------------------------------------
test('reset-password: admin sets a new password and it authenticates', async () => {
  const { users, listRoute, idRoute } = await freshEnv();
  await post(listRoute, { id: 'ron@example.com', name: 'Ron', role: 'creator', domains: ['sales'], password: STRONG });
  const NEW = 'N3wStr0ng-Pass!';
  const res = await patch(idRoute, 'ron@example.com', { op: 'reset-password', password: NEW });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(await users.authenticate('ron@example.com', NEW), 'new password authenticates');
  assert.equal(await users.authenticate('ron@example.com', STRONG), null, 'old password no longer works');
  activeFetch = null;
});

test('reset-password with a weak password is rejected with 400', async () => {
  const { listRoute, idRoute } = await freshEnv();
  await post(listRoute, { id: 'raj@example.com', name: 'Raj', role: 'creator', domains: ['sales'], password: STRONG });
  const res = await patch(idRoute, 'raj@example.com', { op: 'reset-password', password: 'weak' });
  assert.equal(res.status, 400);
  activeFetch = null;
});

// ---------------------------------------------------------------------------
// 4. Offboard with reassignTo moves a personal artifact's owner and deletes user
// ---------------------------------------------------------------------------
test('offboard with reassignTo moves a personal dataset to the target and deletes the user', async () => {
  const { users, listRoute, idRoute } = await freshEnv();
  await post(listRoute, { id: 'sam@example.com', name: 'Sam', role: 'creator', domains: ['sales'], password: STRONG });
  await post(listRoute, { id: 'val@example.com', name: 'Val', role: 'creator', domains: ['sales'], password: STRONG });

  // Seed a PERSONAL-lane dataset owned by sam directly in the data store.
  const data = await import('../data/store.ts');
  data.__resetStore();
  const ds = data.createDataset({ id: 'sam@example.com', domains: ['sales'], role: 'creator' }, { name: 'Sam Personal DS' });

  const res = await del(idRoute, 'sam@example.com', { reassignTo: 'val@example.com' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok((body.report as { total: number }).total >= 1, 'at least one personal artifact reassigned');

  // The dataset is now owned by val; sam is deleted.
  const asVal = data.getDataset(ds.id, { id: 'val@example.com', domains: ['sales'], role: 'creator' });
  assert.equal(asVal.owner, 'val@example.com', 'dataset owner transferred to val');
  assert.equal((await users.listUsers()).find((u) => u.id === 'sam@example.com'), undefined, 'sam deleted');
  data.__resetStore();
  activeFetch = null;
});

// ---------------------------------------------------------------------------
// 5. Guards: offboard self, deactivate last-active-admin
// ---------------------------------------------------------------------------
test('offboard is blocked for your own account', async () => {
  const { idRoute } = await freshEnv();
  const res = await del(idRoute, 'ada', { });
  assert.equal(res.status, 400, 'cannot offboard self');
  activeFetch = null;
});

test('deactivate is blocked for the last active admin', async () => {
  const { listRoute, idRoute } = await freshEnv();
  // Promote a second admin then demote-by-deactivation is fine; but ada is the only
  // admin here, so deactivating ada must be blocked. (Self-guard also applies, so
  // target a DIFFERENT last-admin scenario: make bob the sole admin, ada a creator.)
  await post(listRoute, { id: 'bob@example.com', name: 'Bob', role: 'admin', domains: ['platform'], password: STRONG });
  // Now demote ada to creator via edit so bob is the last admin.
  await patch(idRoute, 'ada', { op: 'edit', name: 'Ada', email: 'ada@example.com', role: 'creator', domains: ['platform'] });
  const res = await patch(idRoute, 'bob@example.com', { op: 'deactivate' });
  assert.equal(res.status, 400, 'cannot deactivate the last active admin');
  activeFetch = null;
});
