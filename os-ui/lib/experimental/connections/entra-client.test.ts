/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GraphConn } from './outlook.ts';
import {
  entraHealth,
  entraListUsers,
  entraGetUser,
  entraListGroups,
  entraListRoleAssignments,
} from './entra.ts';

function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'eyJfake-entra-token-xxx';
function conn(fetchImpl: typeof fetch): GraphConn {
  return { baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl };
}

test('listUsers injects the Bearer, hits /users, shapes rows + truncated flag', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@x.com', mail: 'ada@x.com' }], '@odata.nextLink': 'next' } }));
  const r = await entraListUsers(conn(f.impl));
  assert.ok(r.ok && r.data[0].id === 'u1' && r.data[0].displayName === 'Ada' && r.truncated === true);
  assert.ok(f.calls[0].url.includes('/users'));
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('listUsers with search adds ConsistencyLevel=eventual header', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  await entraListUsers(conn(f.impl), { search: 'ada' });
  const h = new Headers(f.calls[0].init.headers as HeadersInit);
  assert.equal(h.get('consistencylevel'), 'eventual');
  assert.ok(f.calls[0].url.includes('%24search') || f.calls[0].url.includes('$search'));
});

test('getUser needs an id (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await entraGetUser(conn(f.impl), '');
  assert.ok(!r.ok && /user id/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('getUser shapes one user', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/users/ada%40x.com'));
    return { status: 200, body: { id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@x.com', mail: 'ada@x.com' } };
  });
  const r = await entraGetUser(conn(f.impl), 'ada@x.com');
  assert.ok(r.ok && r.data.displayName === 'Ada');
});

test('listGroups shapes rows', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ id: 'g1', displayName: 'Finance', description: 'the finance team' }] } }));
  const r = await entraListGroups(conn(f.impl));
  assert.ok(r.ok && r.data[0].displayName === 'Finance' && r.data[0].description === 'the finance team');
});

test('listRoleAssignments hits roleManagement and shapes assignments', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/roleManagement/directory/roleAssignments'));
    return { status: 200, body: { value: [{ id: 'ra1', principalId: 'u1', roleDefinitionId: 'rd1', directoryScopeId: '/' }] } };
  });
  const r = await entraListRoleAssignments(conn(f.impl));
  assert.ok(r.ok && r.data[0].principalId === 'u1' && r.data[0].roleDefinitionId === 'rd1');
});

test('unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await entraGetUser(conn(f.impl), 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('health: /me 2xx → connected; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { userPrincipalName: 'me@x.com' } }));
  const h = await entraHealth(conn(up.impl));
  assert.ok(h.connected && /me@x.com/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await entraHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '20' } }));
  const r = await entraListUsers(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /20/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await entraListGroups({ baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  await entraListGroups({ baseUrl: 'https://graph.microsoft.com/v1.0', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
