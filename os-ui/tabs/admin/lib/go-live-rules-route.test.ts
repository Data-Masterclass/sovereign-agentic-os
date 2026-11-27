/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — Platform → Go-live rules (App Builder F): admin gate, OPA, flag off, validation
 * USER STORY: As a platform admin I read and change the go-live rule table; a non-admin gets 403 and changes nothing;
 *             OPA can refuse the write; a self-approval field is a 400; and while the App Builder is off the route
 *             answers `app_builder_disabled` before the admin gate or the store is touched.
 * ARCHITECTURE: the real route and the real store (in-memory mirror seam). `adminCtx` is a stand-in that refuses a
 *             non-admin with 403 exactly as `requireAdmin` does; OPA is a stand-in.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { GoLiveRulesMirror } from '@core/policy/go-live-rules-store';

let ROLE = 'admin';
let CTX_CALLS = 0;
mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => {
      CTX_CALLS++;
      if (ROLE !== 'admin') { const e = new Error('Admin only'); (e as Error & { status?: number }).status = 403; throw e; }
      return { user: { id: 'ada', role: 'admin', domains: [] }, tenant: { id: 't' }, opa: 'opa-allow' };
    },
    fail: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number })?.status ?? 500, headers: { 'content-type': 'application/json' } }),
  },
});
let OPA_ALLOWS = true;
const realGoverned = await import('@core/infra/governed');
mock.module('@core/infra/governed', {
  namedExports: { ...realGoverned, authorize: async () => ({ allowed: OPA_ALLOWS, policy: OPA_ALLOWS ? 'opa-allow' : 'opa-deny', decisionId: 'd1' }) },
});

const { GET, PUT } = await import('@/app/api/platform-admin/go-live-rules/route');
const { __setGoLiveRulesMirror } = await import('@core/policy/go-live-rules-store');

const DOCS = new Map<string, unknown>();
let READS = 0;
const fake: GoLiveRulesMirror = {
  probe: async () => true,
  read: async (id) => { READS++; return DOCS.has(id) ? { state: 'found', doc: structuredClone(DOCS.get(id)) } : { state: 'absent' }; },
  writeConfirmed: async (id, doc) => { DOCS.set(id, structuredClone(doc)); return { ok: true }; },
};
const put = (body: unknown) => PUT(new Request('http://os.test/api/platform-admin/go-live-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  ROLE = 'admin';
  OPA_ALLOWS = true;
  CTX_CALLS = 0;
  READS = 0;
  DOCS.clear();
  __setGoLiveRulesMirror(fake);
  process.env.SOFTWARE_APP_BUILDER = 'on';
});
afterEach(() => {
  __setGoLiveRulesMirror(null);
  delete process.env.SOFTWARE_APP_BUILDER;
});

test('flag OFF: GET and PUT answer app_builder_disabled before the admin gate or the store', async () => {
  delete process.env.SOFTWARE_APP_BUILDER;
  for (const res of [await GET(), await put({ rules: [{ kind: 'app', scope: 'my', reviewer: 'admin' }] })]) {
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'app_builder_disabled');
  }
  assert.equal(CTX_CALLS, 0);
  assert.equal(READS, 0);
  assert.equal(DOCS.size, 0);
});

test('GET (admin): the defaults with the closed sets', async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.integrity, 'default');
  assert.deepEqual(body.reviewers, ['none', 'builder', 'domain_admin', 'admin']);
  assert.deepEqual(body.scopes, ['my', 'domain', 'company']);
  assert.equal(body.rules.length, 6);
});

test('a non-admin is refused on read and write, and nothing is written', async () => {
  ROLE = 'domain_admin';
  assert.equal((await GET()).status, 403);
  assert.equal((await put({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'none' }] })).status, 403);
  assert.equal(DOCS.size, 0);
});

test('PUT (admin): saves the whole table with the version it loaded; a stale version is 409', async () => {
  const loaded = await (await GET()).json();
  const rules = loaded.rules.map((r: { kind: string; scope: string; reviewer: string }) => (r.kind === 'app' && r.scope === 'domain' ? { ...r, reviewer: 'builder' } : r));
  const res = await put({ rules, expectedVersion: loaded.version });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.equal(body.integrity, 'sealed');
  assert.equal(body.rules.find((r: { kind: string; scope: string }) => r.kind === 'app' && r.scope === 'domain').reviewer, 'builder');
  assert.equal((await put({ rules, expectedVersion: 0 })).status, 409);
});

test('PUT: OPA deny refuses the write', async () => {
  OPA_ALLOWS = false;
  const res = await put({ rules: [{ kind: 'app', scope: 'my', reviewer: 'admin' }] });
  assert.equal(res.status, 403);
  assert.equal(DOCS.size, 0);
});

test('PUT: a self-approval field, an unknown role or a non-JSON body is a 400', async () => {
  assert.equal((await put({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'domain_admin', selfApproval: true }] })).status, 400);
  assert.equal((await put({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'superuser' }] })).status, 400);
  const bad = await PUT(new Request('http://os.test/api/platform-admin/go-live-rules', { method: 'PUT', body: '{nope' }));
  assert.equal(bad.status, 400);
  assert.equal(DOCS.size, 0);
});
