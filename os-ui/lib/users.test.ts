/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assessPasswordStrength, generateTempPassword, hashPassword, isHashed } from './password.ts';
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

test('ROLES contains exactly creator, builder, domain_admin, admin — no agentic-leader', () => {
  const roles = [...ROLES].sort();
  assert.deepEqual(roles, ['admin', 'builder', 'creator', 'domain_admin']);
  // Order encodes rank: lowest→highest privilege.
  assert.deepEqual([...ROLES], ['creator', 'builder', 'domain_admin', 'admin']);
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

test('domain_admin has domain user-admin + every builder right, but never tenant powers', () => {
  const rights = ROLE_RIGHTS['domain_admin'];
  for (const r of ROLE_RIGHTS['builder']) assert.ok(rights.includes(r), `inherits builder right ${r}`);
  assert.ok(rights.includes('manage.users.domain'));
  assert.ok(rights.includes('manage.memberships.domain'));
  assert.ok(!rights.includes('manage.users.tenant'));
  assert.ok(!rights.includes('promote.certify'));
  assert.ok(!rights.includes('override.policy'));
  assert.ok(!rights.includes('cost.cap.set'));
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

test('legacy normalization: any role outside the 4 → creator; a stored domain_admin passes through (never auto-promoted, never demoted)', async () => {
  const { store, stub } = openSearchStub();
  activeFetch = stub;

  store.set('__meta__', { id: '__meta__', initialized: true });
  const base = { password: await hashPassword(STRONG), domains: ['sales'], emailVerified: true, onboarded: false, createdAt: Date.now() };
  store.set('p@example.com', { id: 'p@example.com', name: 'P', email: 'p@example.com', role: 'participant', ...base } as Record<string, unknown>);
  store.set('x@example.com', { id: 'x@example.com', name: 'X', email: 'x@example.com', role: 'super-user', ...base } as Record<string, unknown>);
  store.set('d@example.com', { id: 'd@example.com', name: 'D', email: 'd@example.com', role: 'domain_admin', ...base } as Record<string, unknown>);
  store.set('a@example.com', { id: 'a@example.com', name: 'A', email: 'a@example.com', role: 'admin', ...base } as Record<string, unknown>);

  const users = await freshUsers();
  const byId = new Map((await users.listUsers()).map((u) => [u.id, u]));
  assert.equal(byId.get('p@example.com')!.role, 'creator', 'participant → creator');
  assert.equal(byId.get('x@example.com')!.role, 'creator', 'unknown role → creator');
  assert.equal(byId.get('d@example.com')!.role, 'domain_admin', 'an explicitly stored domain_admin stays');
  assert.equal(byId.get('a@example.com')!.role, 'admin', 'existing admins stay admin');

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

// ---- Invite: one-time temp password → forced first-login ---------------------

test('generateTempPassword is strong (passes strength) and shareable/unambiguous', () => {
  for (let i = 0; i < 40; i++) {
    const pw = generateTempPassword();
    assert.equal(pw.length, 16);
    assert.ok(assessPasswordStrength(pw).ok, `temp password should pass strength: ${pw}`);
    // Unambiguous alphabet: none of O/0, I/l/1.
    assert.ok(!/[Oo0Il1]/.test(pw), `no ambiguous chars: ${pw}`);
  }
  // Two draws must differ (crypto-random, not a constant).
  assert.notEqual(generateTempPassword(), generateTempPassword());
});

test('invited user signs in with the temp credential, then is REQUIRED to onboard (set own password)', async () => {
  const { store, stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  // Admin invites a student: server mints a one-time temp password, stores only
  // its hash, and flags mustChangeCredentials (mirrors the governance route).
  const tempPassword = generateTempPassword();
  const created = await users.createUser({
    id: 'student1@example.com',
    email: 'student1@example.com',
    password: tempPassword,
    domains: ['cohort'],
    role: 'creator',
    mustChangeCredentials: true,
  });
  assert.equal(created.mustChangeCredentials, true, 'invited account is forced through first-login setup');

  // The plaintext temp password is NEVER persisted — only a scrypt hash.
  const stored = store.get('student1@example.com') as { password?: string; mustChangeCredentials?: boolean };
  assert.ok(isHashed(stored.password), 'stored password is a scrypt hash, not plaintext');
  assert.notEqual(stored.password, tempPassword, 'plaintext temp password is not persisted');
  assert.equal(stored.mustChangeCredentials, true);

  // The invitee CAN authenticate with the issued temp credential…
  const signedIn = await users.authenticate('student1@example.com', tempPassword);
  assert.ok(signedIn, 'invited user authenticates with the temp credential');
  assert.equal(signedIn!.mustChangeCredentials, true, '…and is still required to onboard');

  // A wrong password is rejected (the hash is real).
  assert.equal(await users.authenticate('student1@example.com', 'wrong-password-xx'), null);

  // First-login setup: they set their OWN strong password (bootstrap admin uses
  // setupAdmin instead; this non-bootstrap path only takes the ready hash).
  const myPassword = 'Zephyr!Meadow-72';
  await users.completeFirstLogin('student1@example.com', await hashPassword(myPassword));

  // The temp credential is now dead; the chosen one works; the gate is cleared.
  assert.equal(await users.authenticate('student1@example.com', tempPassword), null, 'temp password no longer works');
  const now = await users.authenticate('student1@example.com', myPassword);
  assert.ok(now, 'invited user signs in with their own password');
  assert.equal(now!.mustChangeCredentials ?? false, false, 'forced first-login gate is cleared');

  activeFetch = null;
});

test('completeFirstLogin refuses the bootstrap admin and already-set accounts', async () => {
  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  // Bootstrap admin must use setupAdmin, never completeFirstLogin.
  await assert.rejects(
    users.completeFirstLogin('admin', await hashPassword('Zephyr!Meadow-72')),
    /bootstrap setup/i,
  );

  // A normal (already set-up) account has no pending first-login setup.
  await users.createUser({ id: 'set@example.com', email: 'set@example.com', password: 'Zephyr!Meadow-72', domains: ['cohort'], role: 'creator' });
  await assert.rejects(
    users.completeFirstLogin('set@example.com', await hashPassword('Another!Strong-99')),
    /already completed/i,
  );

  activeFetch = null;
});
