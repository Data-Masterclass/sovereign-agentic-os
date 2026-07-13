/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../core/password.ts';

/**
 * /api/governance/users PATCH — the "Edit user" flow behind the Admin →
 * User & access tab. These drive the REAL route handler end-to-end (real users
 * store, real role-gate) with only `currentUser` mocked, proving:
 *
 *  - an Admin can edit a user's name/email/role/domains and it PERSISTS;
 *  - a Domain admin can edit a Creator inside their own domain;
 *  - a Creator (no user-admin rights) is refused (403);
 *  - a Domain admin may NOT lift a user to admin (role ceiling), nor touch a
 *    user outside their domain scope.
 *
 * Requires `--experimental-test-module-mocks` (set in the npm test script) and
 * the test-only `next/server` shim (scripts/test-next-server.mjs, mapped by the
 * alias hook). Each case re-imports the route with a fresh query string so the
 * mocked `currentUser` binds per-actor.
 */

type Actor = { id: string; name: string; domains: string[]; role: string };

// `mock.module` may register a specifier only ONCE per process, so mock
// `@/lib/auth` a single time and swap the acting user through a mutable holder.
let ACTING: Actor = { id: 'ada', name: 'Ada', domains: ['platform'], role: 'admin' };
mock.module('@/lib/core/auth', { namedExports: { currentUser: async () => ACTING } });

async function patch(actor: Actor, body: Record<string, unknown>, tag: string) {
  ACTING = actor;
  // Offline mirror → in-memory users store (no cluster needed).
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };

  const users = await import('../platform-admin/users.ts');
  users.__resetUsers();
  // A real admin (via the forced first-run setup) + a couple of targets.
  await users.setupAdmin({
    bootstrapId: 'admin', username: 'ada', email: 'ada@example.com',
    passwordHashReady: await hashPassword('Tr0ub4dour&3-test'),
  });
  await users.createUser({ id: 'bob@example.com', email: 'bob@example.com', password: 'Tr0ub4dour&3-test', domains: ['sales'], role: 'creator' });
  await users.createUser({ id: 'zoe@example.com', email: 'zoe@example.com', password: 'Tr0ub4dour&3-test', domains: ['legal'], role: 'creator' });

  const route = await import(`../../app/api/governance/users/route.ts?${tag}`);
  const req = new Request('http://localhost/api/governance/users', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await route.PATCH(req) as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json(), users };
}

const ADMIN: Actor = { id: 'ada', name: 'Ada', domains: ['platform'], role: 'admin' };
const DOMAIN_ADMIN: Actor = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'domain_admin' };
const CREATOR: Actor = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };

test('PATCH: admin edits name/email/role/domains and it PERSISTS', async () => {
  const { status, body, users } = await patch(
    ADMIN,
    { id: 'bob@example.com', name: 'Bob Smith', email: 'bob.smith@example.com', role: 'builder', domains: ['sales'] },
    'admin-edit',
  );
  assert.equal(status, 200, `admin edit should succeed: ${JSON.stringify(body)}`);
  const u = body.user as { name: string; email: string; role: string; roleLabel: string };
  assert.equal(u.name, 'Bob Smith');
  assert.equal(u.email, 'bob.smith@example.com');
  assert.equal(u.role, 'builder');
  assert.equal(u.roleLabel, 'Builder');
  // The change is durable in the store, not just echoed back.
  const persisted = (await users.listUsers()).find((x) => x.id === 'bob@example.com');
  assert.equal(persisted?.name, 'Bob Smith');
  assert.equal(persisted?.role, 'builder');
});

test('PATCH: admin editing preserves email when the form re-sends id===email', async () => {
  // Guards against the edit form wiping an email that equals the login id.
  const { status, body } = await patch(
    ADMIN,
    { id: 'bob@example.com', name: 'Bob Renamed', email: 'bob@example.com', role: 'creator', domains: ['sales'] },
    'admin-edit-same-email',
  );
  assert.equal(status, 200);
  assert.equal((body.user as { email: string }).email, 'bob@example.com');
});

test('PATCH: domain_admin edits a creator inside their own domain', async () => {
  const { status, body } = await patch(
    DOMAIN_ADMIN,
    { id: 'bob@example.com', name: 'Bob (domain edit)', email: 'bob@example.com', role: 'creator', domains: ['sales'] },
    'da-edit',
  );
  assert.equal(status, 200, `domain_admin in-scope edit should succeed: ${JSON.stringify(body)}`);
  assert.equal((body.user as { name: string }).name, 'Bob (domain edit)');
});

test('PATCH: a creator (no user-admin rights) is refused with 403', async () => {
  const { status } = await patch(
    CREATOR,
    { id: 'bob@example.com', name: 'Nope', email: 'bob@example.com', role: 'creator', domains: ['sales'] },
    'creator-denied',
  );
  assert.equal(status, 403);
});

test('PATCH: domain_admin cannot lift a user to admin (role ceiling)', async () => {
  const { status } = await patch(
    DOMAIN_ADMIN,
    { id: 'bob@example.com', name: 'Bob', email: 'bob@example.com', role: 'admin', domains: ['sales'] },
    'da-ceiling',
  );
  assert.equal(status, 403);
});

test('PATCH: domain_admin cannot edit a user outside their domain scope', async () => {
  const { status } = await patch(
    DOMAIN_ADMIN,
    { id: 'zoe@example.com', name: 'Zoe', email: 'zoe@example.com', role: 'creator', domains: ['legal'] },
    'da-out-of-scope',
  );
  assert.equal(status, 403);
});

// ---- Password reset via PATCH ------------------------------------------------

async function patchWithReset(actor: Actor, body: Record<string, unknown>, tag: string) {
  ACTING = actor;
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };

  const users = await import('../platform-admin/users.ts');
  users.__resetUsers();
  await users.setupAdmin({
    bootstrapId: 'admin', username: 'ada', email: 'ada@example.com',
    passwordHashReady: await hashPassword('Tr0ub4dour&3-test'),
  });
  await users.createUser({ id: 'bob@example.com', email: 'bob@example.com', password: 'Tr0ub4dour&3-test', domains: ['sales'], role: 'creator' });

  const route = await import(`../../app/api/governance/users/route.ts?${tag}`);
  const req = new Request('http://localhost/api/governance/users', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await route.PATCH(req) as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json(), users };
}

test('PATCH resetPassword: admin can reset a password; new credential authenticates', async () => {
  const { status, body, users } = await patchWithReset(
    ADMIN,
    { id: 'bob@example.com', resetPassword: true, password: 'NewStr0ng!Pass2026' },
    'admin-pw-reset',
  );
  assert.equal(status, 200, `reset should succeed: ${JSON.stringify(body)}`);
  // Server echoes the new password once.
  assert.equal((body as { tempPassword?: string }).tempPassword, 'NewStr0ng!Pass2026');
  // New credential authenticates.
  const auth = await users.authenticate('bob@example.com', 'NewStr0ng!Pass2026');
  assert.ok(auth, 'new password authenticates after reset');
  // Old credential no longer works.
  assert.equal(await users.authenticate('bob@example.com', 'Tr0ub4dour&3-test'), null);
});

test('PATCH resetPassword: domain_admin is denied (only platform admin may reset passwords)', async () => {
  const { status } = await patchWithReset(
    DOMAIN_ADMIN,
    { id: 'bob@example.com', resetPassword: true, password: 'NewStr0ng!Pass2026' },
    'da-pw-reset-denied',
  );
  assert.equal(status, 403);
});

test('PATCH resetPassword: weak password is rejected with 400', async () => {
  const { status, body } = await patchWithReset(
    ADMIN,
    { id: 'bob@example.com', resetPassword: true, password: 'weak' },
    'admin-pw-reset-weak',
  );
  assert.equal(status, 400, `weak password should be rejected: ${JSON.stringify(body)}`);
});
