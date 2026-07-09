/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Tests for the `edit` op on PATCH /api/platform-admin/access/[id].
 *
 * Drives the real route handler end-to-end with only the auth + platform-admin
 * context mocked, proving that editing name/email/role/domains via the Platform
 * Admin → Users & Access surface persists and is reflected in the user list.
 *
 * Uses `--experimental-test-module-mocks` (set in the npm test script) and the
 * test-only next/server shim (scripts/test-next-server.mjs, mapped by the alias
 * hook). Each invocation reimports the route with a fresh query-string tag so the
 * mocked modules bind per-test without cross-contamination.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../core/password.ts';
import { __resetUsers } from '../users.ts';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

// OpenSearch stub (mirrors lib/users.test.ts pattern — offline-friendly).
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

// Platform-admin ctx mock — `adminCtx()` is called by the route; we replace the
// whole module so the route gets a canned admin user without needing real auth,
// Ory, OPA, or the tenant registry.
type MockAdminCtx = { id: string; role: string; domains: string[] };
let ACTING_ADMIN: MockAdminCtx = { id: 'ada', role: 'admin', domains: ['platform'] };

mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => ({
      user: ACTING_ADMIN,
      tenant: { id: 'test-tenant' },
      opa: 'opa-allow',
    }),
    fail: (e: unknown) => {
      const status = (e as { status?: number })?.status ?? 500;
      return { status, async json() { return { error: (e as Error).message }; } };
    },
  },
});

// Stub `_compile` (called after each PATCH to push OPA policy) — no-op in tests.
mock.module('@/app/api/platform-admin/_compile', {
  namedExports: { recompile: async () => ({ publish: 'skipped' }) },
});

// Stub audit — no-op in tests (the real audit writes to OpenSearch).
mock.module('@/lib/platform-admin/audit', {
  namedExports: { audit: () => undefined },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRONG = 'Tr0ub4dour&3-test';
let routeTag = 0;

/** Reset stores, seed two users, and call PATCH /api/platform-admin/access/{id}. */
async function editViaRoute(
  targetId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; users: typeof import('../users.ts') }> {
  routeTag += 1;
  const { stub } = openSearchStub();
  activeFetch = stub;

  __resetUsers();
  const users = await import('../users.ts');

  await users.setupAdmin({
    bootstrapId: 'admin',
    username: 'ada',
    email: 'ada@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });
  await users.createUser({
    id: 'bob@example.com',
    email: 'bob@example.com',
    password: STRONG,
    domains: ['sales'],
    role: 'creator',
  });

  const route = await import(`../../app/api/platform-admin/access/[id]/route.ts?t=${routeTag}`);
  const req = new Request(`http://localhost/api/platform-admin/access/${targetId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await route.PATCH(req, { params: Promise.resolve({ id: targetId }) }) as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  const respBody = await res.json();
  activeFetch = null;
  return { status: res.status, body: respBody, users };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('edit op: admin edits name and it persists in the user store', async () => {
  const { status, body, users } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Bob Smith',
    email: 'bob@example.com',
    role: 'creator',
    domains: ['sales'],
  });
  assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
  const persisted = (await users.listUsers()).find((u) => u.id === 'bob@example.com');
  assert.equal(persisted?.name, 'Bob Smith', 'name change persisted');
});

test('edit op: admin edits email and it persists', async () => {
  const { status, body, users } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Bob',
    email: 'bob.new@example.com',
    role: 'creator',
    domains: ['sales'],
  });
  assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
  const persisted = (await users.listUsers()).find((u) => u.id === 'bob@example.com');
  assert.equal(persisted?.email, 'bob.new@example.com', 'email change persisted');
});

test('edit op: admin upgrades role to builder and it persists', async () => {
  const { status, body, users } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Bob',
    email: 'bob@example.com',
    role: 'builder',
    domains: ['sales'],
  });
  assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
  const persisted = (await users.listUsers()).find((u) => u.id === 'bob@example.com');
  assert.equal(persisted?.role, 'builder', 'role change persisted');
});

test('edit op: admin changes domain membership and it persists', async () => {
  const { status, body, users } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Bob',
    email: 'bob@example.com',
    role: 'creator',
    domains: ['marketing'],
  });
  assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
  const persisted = (await users.listUsers()).find((u) => u.id === 'bob@example.com');
  assert.deepEqual(persisted?.domains, ['marketing'], 'domain change persisted');
});

test('edit op: edits all four fields together and all persist', async () => {
  const { status, body, users } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Robert Smith',
    email: 'robert@example.com',
    role: 'builder',
    domains: ['sales', 'marketing'],
  });
  assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
  const persisted = (await users.listUsers()).find((u) => u.id === 'bob@example.com');
  assert.equal(persisted?.name, 'Robert Smith', 'name persisted');
  assert.equal(persisted?.email, 'robert@example.com', 'email persisted');
  assert.equal(persisted?.role, 'builder', 'role persisted');
  assert.deepEqual(persisted?.domains.sort(), ['marketing', 'sales'], 'domains persisted');
});

test('edit op: invalid op returns 400', async () => {
  const { status } = await editViaRoute('bob@example.com', { op: 'nonexistent' });
  assert.equal(status, 400);
});

test('edit op: empty domains array is rejected with 400', async () => {
  const { status, body } = await editViaRoute('bob@example.com', {
    op: 'edit',
    name: 'Bob',
    email: 'bob@example.com',
    role: 'creator',
    domains: [],
  });
  assert.equal(status, 400, `expected 400 but got ${status}: ${JSON.stringify(body)}`);
});
