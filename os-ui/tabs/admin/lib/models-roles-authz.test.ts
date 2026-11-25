/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Models: only an admin that OPA also allows may map the roles.
 * USER STORY: As the platform owner I want a creator, an anonymous caller, or an admin whom the policy
 *             engine denies, to be unable to change which model a role means.
 * ARCHITECTURE:
 *   - The REAL `adminCtx` + `requireAdmin` + signed session cookie run (only `next/headers` supplies the
 *     cookie). OPA's decision (`authorize`) is the one switch. The route's own OPA check is the SECOND
 *     gate: `adminCtx`'s OPA call is deliberately non-fatal, so deleting `authorize(...,'admin')` from the
 *     route makes the "OPA denies" test fail.
 *   - Every refusal changes nothing: no file commit, no gateway write, no audit entry.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, sessionCookieName } from '@core/kernel/session';
import { config } from '@core/kernel/config';

const state = { token: undefined as string | undefined, opaAllows: true, file: null as Record<string, string> | null, commits: 0, gatewayWrites: 0, audits: 0 };
mock.module('next/headers', { namedExports: { cookies: async () => ({ get: (n: string) => (n === sessionCookieName() && state.token ? { value: state.token } : undefined) }) } });
mock.module('@core/infra/governed', {
  namedExports: { authorize: async () => (state.opaAllows ? { allowed: true, policy: 'opa-allow' } : { allowed: false, policy: 'opa-deny' }) },
});
mock.module('@tabs/admin/lib/audit', { namedExports: { audit: () => { state.audits++; } } });
mock.module('@core/models/role-live', {
  namedExports: {
    liveRoleIo: () => ({
      readMapping: async () => state.file,
      writeMapping: async (m: Record<string, string>) => { state.file = m; state.commits++; return { sha: 'abc', changed: true }; },
      catalog: async () => ({ ok: true, data: ['big', 'small', 'emb'] }),
      readAliases: async () => ({ ok: true, data: {} }),
      writeAliases: async () => { state.gatewayWrites++; return { ok: true, data: {} }; },
      readRevision: async () => 'r1',
      audit: () => undefined,
      log: () => undefined,
    }),
  },
});

const route = await import('../../../app/api/platform-admin/models/roles/route.ts');
// The session is checked against the LIVE user directory (core/kernel/auth.ts): sign in real users.
const { createUser, __resetUsers } = await import('@tabs/admin/lib/users');
const ROLES = { 'sovereign-strong': 'big', 'sovereign-worker': 'small', 'sovereign-embedding': 'emb' };
const put = () => route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ roles: ROLES }) }));
const login = async (id: string, role: 'admin' | 'creator') => {
  __resetUsers();
  await createUser({ id, name: id, password: 'x', domains: ['platform'], role, email: `${id}@example.com` });
  state.token = await signSession({ id, name: id, domains: ['platform'], role }, config.sessionSecret);
};
const untouched = () => assert.deepEqual([state.commits, state.gatewayWrites, state.audits], [0, 0, 0], 'a refusal changes nothing');

beforeEach(() => { state.token = undefined; state.opaAllows = true; state.file = null; state.commits = 0; state.gatewayWrites = 0; state.audits = 0; });

test('an admin that OPA allows can map the roles (the positive control)', async () => {
  await login('admin1', 'admin');
  assert.equal((await put()).status, 200);
  assert.deepEqual([state.commits, state.gatewayWrites, state.audits], [1, 1, 1]);
});

test('NEGATIVE TWIN: a non-admin (creator) gets 403 and nothing changes', async () => {
  await login('maya', 'creator');
  assert.equal((await put()).status, 403);
  untouched();
});

test('NEGATIVE TWIN: no session gets 401 and nothing changes', async () => {
  assert.equal((await put()).status, 401);
  untouched();
});

test('NEGATIVE TWIN: an admin whom OPA denies gets 403 policy_denied and nothing changes', async () => {
  await login('admin1', 'admin');
  state.opaAllows = false;
  const res = await put();
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code?: string }).code, 'policy_denied');
  untouched();
});
