/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    /api/prefs/locale at the HTTP boundary — governed save, cookie mirror
 * USER STORY: As a platform owner I want the language save refused (403, nothing written) when policy denies it
 *             or the policy engine does not answer; as a user I want my device's cookie re-set to my saved language.
 * ARCHITECTURE:
 *   - Drives the REAL route handlers with real Requests. The session is mocked at the auth seam
 *     (`@core/kernel/auth`); OPA and OpenSearch are played over `fetch` (OPA with a scripted verdict, OpenSearch as
 *     an in-memory doc store); the prefs store is the real one.
 */
import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let verdict: boolean | 'unreachable' = true;
let asks: Record<string, unknown>[] = [];
const DOCS = new Map<string, Record<string, unknown>>();
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.includes('/v1/data/agentic/authz/user_pref_write')) {
    asks.push((JSON.parse(init?.body ?? '{}') as { input: Record<string, unknown> }).input);
    if (verdict === 'unreachable') throw new Error('connect ECONNREFUSED');
    return json({ result: verdict, decision_id: 'dec-1' });
  }
  if (u.endsWith('/v1/config')) return json({ result: { labels: { policy_rev: 'rev-1' } } });
  const byId = u.match(/\/os-user-prefs\/_doc\/([^?]+)/);
  if (byId) {
    const id = decodeURIComponent(byId[1]);
    if (init?.method === 'PUT') { DOCS.set(id, JSON.parse(String(init.body))); return json({ result: 'created' }, 201); }
    const d = DOCS.get(id);
    return d ? json({ _source: d }) : json({ found: false }, 404);
  }
  if (u.includes('/os-user-prefs')) return new Response(init?.method === 'HEAD' ? null : '{"count":0}', { status: 200 });
  throw new Error(`offline-stub: ${u}`);
}) as typeof fetch;

const USER = { id: 'cara', name: 'Cara', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
mock.module('@core/kernel/auth', { namedExports: { requireUser: async () => USER, currentUser: async () => USER } });

const route = await import('@/app/api/prefs/locale/route');
const { __resetLocaleForTests, localeDocId } = await import('@core/prefs/locale');

beforeEach(() => { verdict = true; asks = []; DOCS.clear(); __resetLocaleForTests(); });
after(() => { globalThis.fetch = realFetch; });

const put = (locale: unknown) => route.PUT(new Request('https://os.test/api/prefs/locale', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }),
}));
const get = () => route.GET(new Request('https://os.test/api/prefs/locale'));
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? '';

test('PUT: policy allows → saved server-side, the user-bound cookie is set, OPA was asked about the OWN record', async () => {
  const res = await put('de');
  assert.equal(res.status, 200);
  assert.equal(DOCS.get(localeDocId('cara'))?.locale, 'de');
  assert.match(setCookie(res), /soa-locale=de\.cara/);
  assert.deepEqual(asks[0], { action: 'user.pref.write', pref: 'locale', actor: { id: 'cara', role: 'creator', domains: ['sales'] }, target: { user: 'cara' }, principal: 'user:cara', tool: 'user.pref.write' });
});

test('PUT: policy DENIES → 403, nothing written, no cookie', async () => {
  verdict = false;
  const res = await put('fr');
  assert.equal(res.status, 403);
  assert.equal(DOCS.size, 0);
  assert.doesNotMatch(setCookie(res), /soa-locale=/);
});

test('PUT: the policy engine does NOT answer → 403 (fail closed), nothing written', async () => {
  verdict = 'unreachable';
  const res = await put('fr');
  assert.equal(res.status, 403);
  assert.equal(DOCS.size, 0);
  assert.doesNotMatch(setCookie(res), /soa-locale=/);
});

test('PUT: an unknown language is a 400 before policy is asked', async () => {
  const res = await put('xx');
  assert.equal(res.status, 400);
  assert.equal(asks.length, 0);
});

test('GET: a saved language re-sets the cookie (the stale-device sync); nothing saved → no cookie, English', async () => {
  let res = await get();
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { locale: string }).locale, 'en');
  assert.doesNotMatch(setCookie(res), /soa-locale=/);

  DOCS.set(localeDocId('cara'), { userId: 'cara', locale: 'pl' }); // saved on another device / pod
  __resetLocaleForTests();
  res = await get();
  assert.equal(((await res.json()) as { locale: string }).locale, 'pl');
  assert.match(setCookie(res), /soa-locale=pl\.cara/);
  assert.equal(asks.length, 0, 'a read writes nothing and asks no policy');
});
