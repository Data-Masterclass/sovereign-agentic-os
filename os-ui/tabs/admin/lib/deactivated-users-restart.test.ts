/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A deactivated user stays deactivated: after an os-ui restart, at sign-in, for a
 *             still-valid session cookie and in every OPA document compiled from the directory.
 * USER STORY: As an admin who deactivated someone, I want them to lose access for good — not get
 *             their rights back the next time the OS restarts.
 * ARCHITECTURE:
 *   - The REAL user directory (`users.ts`), the REAL tenant-status store (`tenant-users.ts`), the
 *     REAL `currentUser()` and the REAL OPA state sources (`opa-state-sources.ts`), captured into a
 *     bundle tree instead of OPA. Only OpenSearch (one in-memory stub, per index) and the request
 *     cookie jar are stubbed.
 *   - "Restart" = the process state of both stores is dropped while the durable mirror keeps its
 *     documents — exactly what a pod roll does.
 *   - Bugs covered: (1) the boot grants compile read the status store before it was ever loaded,
 *     so every deactivated user compiled as active; (2) a status store that could not be read was
 *     taken as "nobody is deactivated"; (3) a deactivation on Access never reached the directory's
 *     `disabled` flag, so sign-in, the session cookie and `os_data.users` still treated the user as
 *     active.
 *   - Negative twins: an active user is unaffected; reactivating restores access.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '@core/kernel/password';
import { signSession, sessionCookieName } from '@core/kernel/session';
import { config } from '@core/kernel/config';
import { captureOpaWrites } from '@core/policy/opa-capture';
import { bundledOpaStateSources, __resetOpaReconcile } from '@core/policy/opa-reconcile';

// ------------------------------------------------------------------ OpenSearch stub (per index) --
type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
const realFetch = globalThis.fetch;
const STORE = new Map<string, Record<string, unknown>>();
/** Indices answering 503 — the mirror is down for them. */
const DOWN = new Set<string>();
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const stub: Stub = async (url, init = {}) => {
  let path: string;
  try { path = new URL(url).pathname; } catch { return jsonRes({}, 404); }
  if (!new URL(url).hostname.includes('opensearch')) return jsonRes({}, 404);
  const method = (init.method ?? 'GET').toUpperCase();
  const index = path.split('/')[1] ?? '';
  if (DOWN.has(index)) return jsonRes({ error: 'unavailable' }, 503);
  const inIndex = () => [...STORE.entries()].filter(([k]) => k.startsWith(`${index}\u0000`)).map(([, v]) => v);
  if (path.endsWith('/_count')) return jsonRes({ count: inIndex().length });
  if (path.endsWith('/_search')) return jsonRes({ hits: { hits: inIndex().map((_source) => ({ _source })) } });
  const m = path.match(/\/_doc\/(.+)$/) ?? path.match(/\/_update\/(.+)$/);
  if (m) {
    const id = `${index}\u0000${decodeURIComponent(m[1])}`;
    if (method === 'DELETE') { STORE.delete(id); return jsonRes({ result: 'deleted' }); }
    if (method === 'PUT' || method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      STORE.set(id, (body.doc as Record<string, unknown>) ?? body);
      return jsonRes({ result: 'created' });
    }
  }
  return jsonRes({}, 200);
};
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) => stub(String(url), init)) as typeof fetch;
void realFetch;

// ------------------------------------------------------------------ cookie jar --
const jar = { token: undefined as string | undefined };
mock.module('next/headers', {
  namedExports: {
    cookies: async () => ({ get: (n: string) => (n === sessionCookieName() && jar.token ? { value: jar.token } : undefined) }),
  },
});

const users = await import('./users.ts');
const tenant = await import('./tenant-users.ts');
const { currentUser, principalById } = await import('@core/kernel/auth');
const { registerOpaStateSources } = await import('@/opa-state-sources');

const PW = 'Tr0ub4dour&3-test';

/** Wait until the fire-and-forget mirror writes have landed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** A pod roll: both stores lose their process state, the durable mirror keeps its documents. */
function restart(): void {
  users.__resetUsers();
  tenant._resetTenantUsers();
}

async function freshTenant(): Promise<void> {
  STORE.clear();
  DOWN.clear();
  restart();
  await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(PW) });
  for (const id of ['dora@example.com', 'abe@example.com']) {
    await users.createUser({ id, name: id, email: id, password: PW, domains: ['sales'], role: 'creator' });
  }
  await settle();
}

async function compiled(id: string) {
  return (await tenant.compileUsers()).find((u) => u.id === id);
}

/** Run one bundled OPA source in capture mode; returns its result and the captured tree. */
async function runSource(name: string) {
  __resetOpaReconcile();
  registerOpaStateSources();
  const src = bundledOpaStateSources().find((s) => s.name === name);
  assert.ok(src, `source ${name} is registered`);
  const { result, tree } = await captureOpaWrites({}, () => src!.restore());
  return { result, tree: tree as { grants?: Record<string, string[]>; os_data?: { users?: Record<string, { active: boolean }> } } };
}

beforeEach(async () => {
  jar.token = undefined;
  await freshTenant();
});

// ---------------------------------------------------------------- (1) restart --
test('after a restart, the compile does not re-grant a user deactivated on Access (status store not yet loaded)', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  assert.equal((await compiled('dora@example.com'))?.active, false, 'the deactivated user compiles as inactive after a restart');
  assert.equal((await compiled('abe@example.com'))?.active, true, 'NEGATIVE TWIN: an active user still compiles as active');
});

test('after a restart, a deactivation recorded only in the status store (before this fix) still holds — and is carried to the directory', async () => {
  // The record an older release left: status "deactivated", directory flag never set.
  STORE.set('os-tenant-user-status\u0000dora@example.com', { id: 'dora@example.com', status: 'deactivated' });
  restart();
  assert.equal((await compiled('dora@example.com'))?.active, false, 'the old deactivation is honoured by the compile');
  await settle();
  restart();
  assert.equal(await users.authenticate('dora@example.com', PW), null, 'and the user can no longer sign in');
  assert.ok(await users.authenticate('abe@example.com', PW), 'NEGATIVE TWIN: an active user still signs in');
});

test('the grants source compiles from the loaded status after a restart: no grants for the deactivated user', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  const { result, tree } = await runSource('grants');
  assert.equal(result.ok, true, result.detail);
  assert.equal(tree.grants?.['user:dora@example.com'], undefined, 'the deactivated user is granted nothing');
  assert.ok((tree.grants?.['user:abe@example.com'] ?? []).length > 0, 'NEGATIVE TWIN: the active user keeps their grants');
});

// ---------------------------------------------------------------- (2) status store unreadable --
test('a status store that cannot be read is NOT taken as "everyone active": the compile refuses and the grants source returns ok:false', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  DOWN.add('os-tenant-user-status');
  await assert.rejects(() => tenant.compileUsers(), /tenant status/i, 'the compile refuses rather than granting');
  const { result, tree } = await runSource('grants');
  assert.equal(result.ok, false, 'the grants source fails closed');
  assert.match(result.detail, /tenant status not loaded/i);
  assert.equal(tree.grants, undefined, 'nothing was published');
});

test('a failed status load is not cached: once the store answers, the compile loads it and the user stays deactivated', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  DOWN.add('os-tenant-user-status');
  await assert.rejects(() => tenant.compileUsers());
  DOWN.delete('os-tenant-user-status');
  assert.equal((await compiled('dora@example.com'))?.active, false);
  assert.equal((await compiled('abe@example.com'))?.active, true);
});

// ---------------------------------------------------------------- (3) sign-in, cookie, os_data.users --
test('a user deactivated on Access cannot sign in; reactivating lets them sign in again', async () => {
  assert.ok(await users.authenticate('dora@example.com', PW), 'precondition: signs in while active');
  await tenant.deactivateUser('dora@example.com');
  assert.equal(await users.authenticate('dora@example.com', PW), null, 'a deactivated user cannot sign in');
  await settle();
  restart();
  assert.equal(await users.authenticate('dora@example.com', PW), null, 'nor after a restart');
  await tenant.reactivateUser('dora@example.com');
  assert.ok(await users.authenticate('dora@example.com', PW), 'NEGATIVE TWIN: reactivated → signs in again');
});

test("a deactivated user's still-valid session cookie no longer signs them in; reactivation restores it", async () => {
  jar.token = await signSession({ id: 'dora@example.com', name: 'Dora', domains: ['sales'], role: 'creator' }, config.sessionSecret);
  assert.equal((await currentUser())?.id, 'dora@example.com', 'precondition: the cookie works while active');
  await tenant.deactivateUser('dora@example.com');
  assert.equal(await currentUser(), null, 'the cookie is rejected');
  assert.equal(await principalById('dora@example.com'), null, 'and the headless doors refuse the user too');
  await tenant.reactivateUser('dora@example.com');
  assert.equal((await currentUser())?.id, 'dora@example.com', 'NEGATIVE TWIN: reactivated → the cookie works again');
});

test('os_data.users reports a deactivated user as active:false (also after a restart); reactivation restores active:true', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  let { result, tree } = await runSource('os-data-users');
  assert.equal(result.ok, true, result.detail);
  assert.equal(tree.os_data?.users?.['dora@example.com']?.active, false);
  assert.equal(tree.os_data?.users?.['abe@example.com']?.active, true, 'NEGATIVE TWIN: the active user is active');
  await tenant.reactivateUser('dora@example.com');
  ({ result, tree } = await runSource('os-data-users'));
  assert.equal(tree.os_data?.users?.['dora@example.com']?.active, true, 'reactivated → active again');
});

test('os_data.users refuses (ok:false) while the status store cannot be read', async () => {
  restart();
  DOWN.add('os-tenant-user-status');
  const { result } = await runSource('os-data-users');
  assert.equal(result.ok, false);
  assert.match(result.detail, /tenant status not loaded/i);
});

test('the Access list shows the deactivation after a restart', async () => {
  await tenant.deactivateUser('dora@example.com');
  await settle();
  restart();
  const list = await tenant.listAccess();
  assert.equal(list.find((u) => u.id === 'dora@example.com')?.active, false);
  assert.equal(list.find((u) => u.id === 'dora@example.com')?.status, 'deactivated');
  assert.equal(list.find((u) => u.id === 'abe@example.com')?.active, true);
});
