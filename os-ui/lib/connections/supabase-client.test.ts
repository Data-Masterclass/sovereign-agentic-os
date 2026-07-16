/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type SupabaseConn,
  supabaseAuthHeaders,
  supabaseHealth,
  isValidProjectRef,
  ddlGuard,
  listProjects,
  listTables,
  listMigrations,
  getAdvisors,
  getProjectUrl,
  executeSql,
} from './supabase.ts';

function fakeFetch(script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'sbp_fake_access_token_xxx';
const REF = 'abcdefghijklmnopqrst'; // 20 alnum chars
function conn(fetchImpl: typeof fetch): SupabaseConn {
  return { baseUrl: 'https://api.supabase.com', token: TOKEN, fetchImpl };
}

test('auth: token → Bearer; no token → no header (honest fail)', () => {
  assert.equal(supabaseAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(supabaseAuthHeaders(undefined).authorization, undefined);
});

test('project-ref validation gates every project-scoped path', () => {
  assert.ok(isValidProjectRef(REF));
  assert.ok(!isValidProjectRef('short'));
  assert.ok(!isValidProjectRef('../etc'));
});

test('ddlGuard blocks DDL/destructive verbs (incl comment-smuggled) and passes SELECT', () => {
  assert.equal(ddlGuard('select * from t'), null);
  assert.equal(ddlGuard('  SELECT 1'), null);
  assert.equal(ddlGuard('drop table t'), 'drop');
  assert.equal(ddlGuard('DELETE FROM t'), 'delete');
  assert.equal(ddlGuard('alter table t add col int'), 'alter');
  assert.equal(ddlGuard('-- harmless\n truncate t'), 'truncate');
  assert.equal(ddlGuard('/* x */ create table t()'), 'create');
});

test('listProjects shapes rows and never leaks keys', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ id: REF, name: 'prod', region: 'eu', status: 'ACTIVE_HEALTHY', service_role_key: 'SHOULD_NOT_SURFACE' }] }));
  const r = await listProjects(conn(f.impl));
  assert.ok(r.ok && r.data[0].name === 'prod');
  assert.ok(!JSON.stringify(r.data).includes('SHOULD_NOT_SURFACE'));
});

test('listTables / listMigrations reject a bad ref before the network', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [] }));
  assert.ok(!(await listTables(conn(f.impl), 'bad')).ok);
  assert.ok(!(await listMigrations(conn(f.impl), 'bad')).ok);
  assert.equal(f.calls.length, 0);
});

test('getAdvisors maps the lints array', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { lints: [{ level: 'ERROR', categories: 'SECURITY', title: 'RLS disabled' }] } }));
  const r = await getAdvisors(conn(f.impl), REF, 'security');
  assert.ok(r.ok && r.data[0].title === 'RLS disabled');
});

test('getProjectUrl returns only the host URL, never keys from the body', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { id: REF, service_role_key: 'SECRET', anon_key: 'ANON' } }));
  const r = await getProjectUrl(conn(f.impl), REF);
  assert.ok(r.ok && r.data.url === `https://${REF}.supabase.co`);
  assert.ok(!JSON.stringify(r.data).includes('SECRET') && !JSON.stringify(r.data).includes('ANON'));
});

test('execute_sql REFUSES DDL before any network call (defence in depth)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await executeSql(conn(f.impl), REF, 'drop table users');
  assert.ok(!r.ok && /refuses DDL/.test(r.reason));
  assert.equal(f.calls.length, 0, 'a refused DDL never hits the API');
});

test('execute_sql runs a SELECT through the query endpoint', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith(`/v1/projects/${REF}/database/query`));
    return { status: 201, body: [{ n: 1 }] };
  });
  const r = await executeSql(conn(f.impl), REF, 'select count(*) from users');
  assert.ok(r.ok);
});

test('401 → honest unauthorized; network error → unreachable (never throws)', async () => {
  const bad = fakeFetch(() => ({ status: 401 }));
  assert.ok(!(await listProjects(conn(bad.impl))).ok);
  const boom = (async () => { throw new Error('x'); }) as typeof fetch;
  const r = await listProjects({ baseUrl: 'https://api.supabase.com', token: TOKEN, fetchImpl: boom });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('health: GET /v1/projects 2xx → connected; 401 → honest not-connected', async () => {
  const up = fakeFetch(() => ({ status: 200, body: [{ id: REF }] }));
  assert.equal((await supabaseHealth(conn(up.impl))).connected, true);
  const bad = fakeFetch(() => ({ status: 401 }));
  assert.equal((await supabaseHealth(conn(bad.impl))).connected, false);
});
