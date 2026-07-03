/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from './password.ts';
import { ROLES } from './session.ts';
import { ROLE_RIGHTS } from './governance/roles.ts';
import { __resetUsers } from './users.ts';

/**
 * Users lib — updateUser (name+email+validation), archiveUser, restoreUser,
 * deleteUser, authz guards, and the role model invariants.
 */

// ---- fetch stub (OpenSearch "os-users") ------------------------------------

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
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/os-users/_count') return jsonRes({ count: store.size });
    if (path === '/os-users/_search')
      return jsonRes({ hits: { hits: [...store.values()].map((_source) => ({ _source })) } });
    const m = path.match(/^\/os-users\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') { store.set(id, JSON.parse(init.body ?? '{}')); return jsonRes({ result: 'created' }); }
      if (method === 'DELETE') { store.delete(id); return jsonRes({ result: 'deleted' }); }
    }
    return jsonRes({}, 404);
  };
  return { store, stub };
}

let v = 0;
async function freshUsers() {
  v += 1;
  return import(`./users.ts?v=${v}`);
}

const STRONG = 'Tr0ub4dour&3-test';

// Clear globalThis-pinned state before every test so each test starts fresh.
beforeEach(() => __resetUsers());

// ---- Role model invariants --------------------------------------------------

test('ROLES contains exactly creator, builder, admin — no agentic-leader', () => {
  const roles = [...ROLES].sort();
  assert.deepEqual(roles, ['admin', 'builder', 'creator']);
});

test('creator has base rights but lacks promote.shared and manage.users.tenant', () => {
  const rights = ROLE_RIGHTS['creator'];
  assert.ok(rights.includes('read.own'), 'creator can read.own');
  assert.ok(rights.includes('create.artifact'), 'creator can create.artifact');
  assert.ok(!rights.includes('promote.shared'), 'creator cannot promote.shared');
  assert.ok(!rights.includes('approve.domain'), 'creator cannot approve.domain');
  assert.ok(!rights.includes('manage.users.tenant'), 'creator cannot manage users');
});

test('builder has promote.shared but not promote.certify or manage.users.tenant', () => {
  const rights = ROLE_RIGHTS['builder'];
  assert.ok(rights.includes('promote.shared'));
  assert.ok(!rights.includes('promote.certify'));
  assert.ok(!rights.includes('manage.users.tenant'));
});

test('admin has manage.users.tenant and promote.certify', () => {
  const rights = ROLE_RIGHTS['admin'];
  assert.ok(rights.includes('manage.users.tenant'));
  assert.ok(rights.includes('promote.certify'));
});

// ---- updateUser: name + email -----------------------------------------------

test('updateUser: sets name and email, validates email shape', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  // Bootstrap + setup to get a real admin
  await users.setupAdmin({
    bootstrapId: 'admin',
    username: 'ada',
    email: 'ada@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });

  // Create a target user
  await users.createUser({ id: 'bob@example.com', email: 'bob@example.com', password: STRONG, domains: ['sales'], role: 'creator' });

  // Update name + email
  const updated = await users.updateUser('bob@example.com', { name: 'Bob Smith', email: 'bob.smith@example.com' });
  assert.equal(updated.name, 'Bob Smith');
  assert.equal(updated.email, 'bob.smith@example.com');

  // Invalid email shape rejected
  await assert.rejects(
    () => users.updateUser('bob@example.com', { email: 'not-an-email' }),
    (e: Error) => { assert.ok(e.message.includes('valid email')); return true; },
  );

  activeFetch = null;
});

test('updateUser: rejects duplicate email', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });
  await users.createUser({ id: 'carol@example.com', email: 'carol@example.com', password: STRONG, domains: ['sales'], role: 'creator' });
  await users.createUser({ id: 'dave@example.com', email: 'dave@example.com', password: STRONG, domains: ['sales'], role: 'creator' });

  // dave tries to take carol's email
  await assert.rejects(
    () => users.updateUser('dave@example.com', { email: 'carol@example.com' }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 409); return true; },
  );

  activeFetch = null;
});

// ---- archiveUser / restoreUser ----------------------------------------------

test('archiveUser sets disabled=true; user cannot authenticate', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });
  await users.createUser({ id: 'eve@example.com', email: 'eve@example.com', password: STRONG, domains: ['hr'], role: 'creator' });

  // Before archive: can authenticate
  assert.ok(await users.authenticate('eve@example.com', STRONG), 'can sign in before archive');

  const archived = await users.archiveUser('eve@example.com');
  assert.equal(archived.disabled, true);

  // After archive: cannot authenticate
  assert.equal(await users.authenticate('eve@example.com', STRONG), null, 'cannot sign in after archive');

  activeFetch = null;
});

test('restoreUser clears disabled; user can authenticate again', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });
  await users.createUser({ id: 'eve@example.com', email: 'eve@example.com', password: STRONG, domains: ['hr'], role: 'creator' });

  await users.archiveUser('eve@example.com');
  assert.equal(await users.authenticate('eve@example.com', STRONG), null);

  const restored = await users.restoreUser('eve@example.com');
  assert.equal(restored.disabled, false);
  assert.ok(await users.authenticate('eve@example.com', STRONG), 'can sign in after restore');

  activeFetch = null;
});

test('archiveUser: cannot archive the last active admin', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });

  await assert.rejects(
    () => users.archiveUser('ada'),
    (e: Error) => { assert.ok(e.message.includes('last active admin')); return true; },
  );

  activeFetch = null;
});

// ---- deleteUser -------------------------------------------------------------

test('deleteUser removes user permanently', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });
  await users.createUser({ id: 'frank@example.com', email: 'frank@example.com', password: STRONG, domains: ['eng'], role: 'creator' });

  const before = await users.listUsers();
  assert.ok(before.some((u) => u.id === 'frank@example.com'));

  await users.deleteUser('frank@example.com');

  const after = await users.listUsers();
  assert.ok(!after.some((u) => u.id === 'frank@example.com'));

  activeFetch = null;
});

test('deleteUser: cannot delete the last admin', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });

  await assert.rejects(
    () => users.deleteUser('ada'),
    (e: Error) => { assert.ok(e.message.includes('last admin')); return true; },
  );

  activeFetch = null;
});

// ---- Legacy role migration --------------------------------------------------

test('stored agentic-leader role normalizes to creator on read from OpenSearch', async () => {
  const { store, stub } = openSearchStub();
  activeFetch = stub;

  // Seed the store with a legacy agentic-leader user directly (bypassing the app).
  const legacyUser = {
    id: 'legacy@example.com',
    name: 'Legacy',
    password: await hashPassword(STRONG),
    email: 'legacy@example.com',
    role: 'agentic-leader', // old stored value
    domains: ['default'],
    emailVerified: true,
    onboarded: false,
    createdAt: Date.now(),
  };
  // Also put a meta doc so the store doesn't re-seed
  store.set('__meta__', { id: '__meta__', initialized: true });
  store.set('legacy@example.com', legacyUser as Record<string, unknown>);

  const users = await freshUsers();
  const found = (await users.listUsers()).find((u) => u.id === 'legacy@example.com');
  assert.ok(found, 'legacy user should be visible');
  assert.equal(found!.role, 'creator', 'agentic-leader normalized to creator');

  activeFetch = null;
});

// ---- globalThis pinning -------------------------------------------------------

test('globalThis: soa.users.cache — write on one module instance visible from another', async () => {
  const users1 = await freshUsers();
  const { stub } = openSearchStub();
  activeFetch = stub;

  await users1.setupAdmin({
    bootstrapId: 'admin',
    username: 'pin-test-admin',
    email: 'pin@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });

  const g = (globalThis as any)[Symbol.for('soa.users.cache')];
  assert.ok(g, 'globalThis key is set');
  assert.ok(g.cache instanceof Map, 'cache is a Map on globalThis');
  assert.ok(g.cache.has('pin-test-admin'), 'written user is in globalThis cache');

  // A DIFFERENT module instance (different URL → different module object) must
  // see the same cache because it reads from the same globalThis key.
  const users2 = await freshUsers();
  const found = (await users2.listUsers()).find((u: { id: string }) => u.id === 'pin-test-admin');
  assert.ok(found, 'same user is visible from a different module instance — pinned');

  activeFetch = null;
});
