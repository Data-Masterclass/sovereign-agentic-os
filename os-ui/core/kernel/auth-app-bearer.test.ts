/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The kernel door of the app identity token (App Builder E): only a sealed /api/ route set by the edge
 *             middleware for THIS request; a forged route header anywhere is "not signed in".
 * USER STORY: As the OS owner I want an app token never to act as a user session outside the allowlisted API
 *             routes — not on /oauth/authorize, not on /tools/*, not on a page, not on another /api route.
 * ARCHITECTURE:
 *   - The REAL edge middleware: what it forwards to a handler is read from the `x-middleware-override-headers` /
 *     `x-middleware-request-*` response headers Next.js uses to rewrite the request.
 *   - The REAL `currentUser()`; only `next/headers` (the request headers and cookie jar) and the token check
 *     (`acceptAppBearer`, unit-tested in core/auth/app-token.test.ts) are stubbed, so the test is about the door.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { config } from '@core/kernel/config';
import { signSession, sessionCookieName } from '@core/kernel/session';
import { APP_ROUTE_HEADER, APP_ROUTE_SIG_HEADER, openAppRoute, sealAppRoute } from '@core/kernel/app-route-header';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const APP_TOKEN = `${b64({ alg: 'EdDSA', typ: 'os-app+jwt', kid: 'k1' })}.${b64({ sub: 'alice' })}.c2ln`;

// The test loader shims `next/server` for route tests; the middleware needs the REAL request/response classes.
const req = createRequire(import.meta.url);
const { NextRequest } = req('next/dist/server/web/spec-extension/request') as typeof import('next/dist/server/web/spec-extension/request');
const { NextResponse } = req('next/dist/server/web/spec-extension/response') as typeof import('next/dist/server/web/spec-extension/response');
mock.module('next/server', { namedExports: { NextRequest, NextResponse } });

const state = { headers: new Map<string, string>(), token: undefined as string | undefined, accepted: [] as string[] };
mock.module('next/headers', {
  namedExports: {
    headers: async () => ({ get: (n: string) => state.headers.get(n.toLowerCase()) ?? null }),
    cookies: async () => ({ get: (n: string) => (n === sessionCookieName() && state.token ? { value: state.token } : undefined) }),
  },
});
mock.module('@tabs/admin/lib/users', {
  namedExports: {
    authenticate: async () => null,
    getPublicUser: async (id: string) => ({ id, name: id, role: 'admin', domains: ['sales'] }),
    isReserved: () => false,
  },
});
mock.module('@core/auth/app-identity', {
  namedExports: {
    acceptAppBearer: async (_t: string, method: string, pathname: string) => {
      state.accepted.push(`${method} ${pathname}`);
      return { ok: true, accepted: { principal: { id: 'alice', name: 'Alice', role: 'creator', domains: ['sales'] }, via: 'app:sales/orders:dev' } };
    },
  },
});

const { currentUser } = await import('@core/kernel/auth');
const { middleware } = await import('../../middleware.ts');

beforeEach(() => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  state.headers = new Map();
  state.token = undefined;
  state.accepted = [];
});
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

/** What the middleware forwards to the handler for one request: the rewritten request headers (or null if it did not pass it on). */
async function forwarded(path: string, headers: Record<string, string>, method = 'GET'): Promise<Map<string, string> | null> {
  const res = await middleware(new NextRequest(new URL(path, 'http://os.test'), { method, headers }));
  const list = res.headers.get('x-middleware-override-headers');
  if (!list) return null;
  const out = new Map<string, string>();
  for (const name of list.split(',')) out.set(name, res.headers.get(`x-middleware-request-${name}`) ?? '');
  return out;
}

async function useForwarded(h: Map<string, string> | null): Promise<void> {
  state.headers = new Map([...(h ?? new Map())].map(([k, v]) => [k.toLowerCase(), v]));
}

const forged = async (route: string) => ({ authorization: `Bearer ${APP_TOKEN}`, [APP_ROUTE_HEADER]: route, [APP_ROUTE_SIG_HEADER]: await sealAppRoute(route, 'guessed-secret') });

test('middleware: a client-sent route header is dropped on every branch (/oauth, /tools, /signin, a page, /api), switch on or off', async () => {
  const session = await signSession({ id: 'alice', name: 'Alice', domains: ['sales'], role: 'admin' }, config.sessionSecret);
  for (const flag of ['on', 'off']) {
    process.env.SOFTWARE_APP_BUILDER = flag;
    for (const path of ['/oauth/authorize?client_id=x', '/tools/langfuse/x', '/signin', '/recover', '/data']) {
      const h = await forwarded(path, { ...(await forged('GET /api/auth/me')), cookie: `${sessionCookieName()}=${session}` });
      assert.ok(h, `${path} passes through`);
      assert.equal(h.has(APP_ROUTE_HEADER), false, `${flag} ${path}: no route header reaches the handler`);
      assert.equal(h.has(APP_ROUTE_SIG_HEADER), false, `${flag} ${path}: no seal reaches the handler`);
    }
  }
});

test('middleware: on /api/* with a bearer it sets the REAL method and path, sealed; off it sets nothing', async () => {
  const h = await forwarded('/api/data/datasets', await forged('GET /api/auth/me'));
  assert.equal(h?.get(APP_ROUTE_HEADER), 'GET /api/data/datasets', 'the real path, not the forged one');
  assert.deepEqual(await openAppRoute(h!.get(APP_ROUTE_HEADER)!, h!.get(APP_ROUTE_SIG_HEADER)!, config.sessionSecret), { method: 'GET', pathname: '/api/data/datasets' });
  process.env.SOFTWARE_APP_BUILDER = 'off';
  const off = await forwarded('/api/data/datasets', await forged('GET /api/auth/me'));
  assert.equal(off?.has(APP_ROUTE_HEADER), false);
});

test('door: an app token with a forged route header (as on /oauth/authorize, /tools/x or a page) is not signed in — even with a session cookie', async () => {
  state.token = await signSession({ id: 'alice', name: 'Alice', domains: ['sales'], role: 'admin' }, config.sessionSecret);
  for (const route of ['GET /api/auth/me', 'GET /oauth/authorize', 'POST /api/governance/approvals']) {
    state.headers = new Map(Object.entries(await forged(route)).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(await currentUser(), null, `forged ${route}`);
  }
  state.headers = new Map([['authorization', `Bearer ${APP_TOKEN}`]]);
  assert.equal(await currentUser(), null, 'no route header at all');
  assert.deepEqual(state.accepted, [], 'the token was never even checked');
});

test('door: through the real middleware, only the sealed /api/ route reaches the token check; a page or /oauth path never does', async () => {
  for (const path of ['/oauth/authorize', '/tools/x', '/data']) {
    await useForwarded(await forwarded(path, await forged('GET /api/auth/me')));
    state.headers.set('authorization', `Bearer ${APP_TOKEN}`);
    assert.equal(await currentUser(), null, path);
  }
  assert.deepEqual(state.accepted, []);
  await useForwarded(await forwarded('/api/apps/by-slug/orders/context', { authorization: `Bearer ${APP_TOKEN}` }));
  const u = await currentUser();
  assert.equal(u?.via, 'app:sales/orders:dev');
  assert.deepEqual(state.accepted, ['GET /api/apps/by-slug/orders/context'], 'the allowlist is checked against the real path');
  await useForwarded(await forwarded('/api/data/ask', { authorization: `Bearer ${APP_TOKEN}` }, 'POST'));
  await currentUser();
  assert.equal(state.accepted.at(-1), 'POST /api/data/ask', 'a non-allowlisted /api route reaches the check with its REAL path (refused there: app-token.test.ts)');
});

test('door: switch off ⇒ the bearer is ignored and the session cookie decides, as before', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'off';
  state.token = await signSession({ id: 'alice', name: 'Alice', domains: ['sales'], role: 'admin' }, config.sessionSecret);
  state.headers = new Map(Object.entries(await forged('GET /api/auth/me')).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal((await currentUser())?.via, undefined);
  assert.equal((await currentUser())?.id, 'alice');
  assert.deepEqual(state.accepted, []);
});
