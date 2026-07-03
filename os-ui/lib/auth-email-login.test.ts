/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Email-as-login-label: a user's EMAIL is the human-facing sign-in field, while
 * `id` stays the internal principal/owner/DLS key. Login resolves the typed
 * handle against email OR id (`findByHandle`), email is REQUIRED + validated on
 * `createUser`, and the OS_USERS operator seed maps email → user.
 *
 * This file is isolated (Node's test runner gives each file its own process), so
 * setting OS_USERS BEFORE the first import of `lib/config` deterministically
 * drives the seed path.
 */

// Must be set before any import that pulls in lib/config (which reads it once).
process.env.OS_USERS = JSON.stringify([
  { id: 'maya', name: 'Maya Chen', password: 'Str0ng-Pass-1', domains: ['ops'], role: 'builder', email: 'maya@northpeak.example' },
  { id: 'no-email-handle', name: 'Loginless', password: 'x', domains: ['ops'], role: 'creator' },
]);

// A tiny in-process OpenSearch "os-users" mirror so the seed persists like prod.
type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
let activeFetch: Stub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) =>
  activeFetch ? activeFetch(url, init) : realFetch(url as string, init)) as typeof fetch;

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function openSearchStub(): Stub {
  const store = new Map<string, Record<string, unknown>>();
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/os-users/_count') return jsonRes({ count: store.size });
    if (path === '/os-users/_search') return jsonRes({ hits: { hits: [...store.values()].map((_source) => ({ _source })) } });
    const m = path.match(/^\/os-users\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]).replace(/\?.*$/, '');
      if (method === 'PUT') { store.set(id, JSON.parse(init.body ?? '{}')); return jsonRes({ result: 'created' }); }
      if (method === 'DELETE') { store.delete(id); return jsonRes({ result: 'deleted' }); }
    }
    return jsonRes({}, 404);
  };
}

let v = 0;
async function freshUsers() {
  v += 1;
  return import(`./users.ts?email-case=${v}`);
}

const STRONG = 'Tr0ub4dour&3-horses';

test('login-by-email: a distinct id and email both resolve to the same account', async () => {
  activeFetch = openSearchStub();
  const users = await freshUsers();
  await users.createUser({ id: 'lena', name: 'Lena', password: STRONG, domains: ['sales'], role: 'creator', email: 'lena@acme.example' });

  // Sign in with the EMAIL — the surfaced label.
  const byEmail = await users.authenticate('lena@acme.example', STRONG);
  assert.equal(byEmail?.id, 'lena', 'email resolves to the internal id principal');
  // Case-insensitive email.
  assert.equal((await users.authenticate('LENA@ACME.EXAMPLE', STRONG))?.id, 'lena');
  // The internal id still works (operator/back-compat).
  assert.equal((await users.authenticate('lena', STRONG))?.id, 'lena');
  // Wrong password fails.
  assert.equal(await users.authenticate('lena@acme.example', 'nope'), null);
  activeFetch = null;
});

test('bad email is rejected on createUser (and a non-email id with no email cannot be created)', async () => {
  activeFetch = openSearchStub();
  const users = await freshUsers();
  await assert.rejects(
    () => users.createUser({ id: 'nia', password: STRONG, domains: ['sales'], role: 'creator', email: 'not-an-email' }),
    /valid email/i,
  );
  // No email + a non-email id → there is no sign-in label → rejected.
  await assert.rejects(
    () => users.createUser({ id: 'bare-handle', password: STRONG, domains: ['sales'], role: 'creator' }),
    /valid email/i,
  );
  // An email-shaped id doubles as the email (the "email / login" invite field).
  const u = await users.createUser({ id: 'omar@acme.example', password: STRONG, domains: ['sales'], role: 'creator' });
  assert.equal(u.email, 'omar@acme.example');
  assert.equal((await users.authenticate('omar@acme.example', STRONG))?.id, 'omar@acme.example');
  activeFetch = null;
});

test('OS_USERS seed maps email → user; a seed entry without a valid email is skipped', async () => {
  activeFetch = openSearchStub();
  const users = await freshUsers();
  // The seeded builder signs in by her email...
  const maya = await users.authenticate('maya@northpeak.example', 'Str0ng-Pass-1');
  assert.equal(maya?.id, 'maya');
  assert.equal(maya?.role, 'builder');
  // ...and the loginless entry (no valid email) was NOT seeded.
  const all = await users.listUsers();
  assert.ok(all.some((u) => u.id === 'maya'), 'maya seeded');
  assert.ok(!all.some((u) => u.id === 'no-email-handle'), 'entry without a valid email is skipped');
  assert.equal(all.find((u) => u.id === 'maya')?.email, 'maya@northpeak.example');
  activeFetch = null;
});
