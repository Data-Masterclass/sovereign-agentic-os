/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasLangfuseSession,
  cookiePair,
  loginLangfuse,
  getLangfuseSessionCookies,
  _resetLangfuseSessionCache,
} from './tool-sso-langfuse.ts';

/* --------------------------------------------------------------- pure helpers */

test('hasLangfuseSession detects both NextAuth cookie names, boundary-safe', () => {
  assert.equal(hasLangfuseSession('next-auth.session-token=abc'), true);
  assert.equal(hasLangfuseSession('foo=1; next-auth.session-token=abc; bar=2'), true);
  assert.equal(hasLangfuseSession('__Secure-next-auth.session-token=abc'), true);
  assert.equal(hasLangfuseSession('other=1'), false);
  assert.equal(hasLangfuseSession(''), false);
  assert.equal(hasLangfuseSession(null), false);
  assert.equal(hasLangfuseSession(undefined), false);
  // a cookie whose name merely ends with the token name must NOT match.
  assert.equal(hasLangfuseSession('xnext-auth.session-token=abc'), false);
});

test('cookiePair strips attributes to name=value', () => {
  assert.equal(cookiePair('next-auth.session-token=JWT; Path=/; HttpOnly; SameSite=Lax'), 'next-auth.session-token=JWT');
});

/* ------------------------------------------------------------ login handshake */

function res(body: unknown, setCookies: string[] = [], status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

test('loginLangfuse does the csrf → credentials handshake and returns the session cookie', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/csrf')) {
      return res({ csrfToken: 'csrf123' }, ['next-auth.csrf-token=tok|hash; Path=/; HttpOnly']);
    }
    // credentials callback: carries the csrf cookie, returns the session cookie
    return res({ url: 'http://lf/' }, [
      'next-auth.session-token=THEJWT; Path=/; HttpOnly; SameSite=Lax',
      'next-auth.callback-url=http%3A%2F%2Flf; Path=/',
    ]);
  }) as typeof fetch;

  const cookies = await loginLangfuse({
    fetchImpl: fakeFetch,
    baseUrl: 'http://lf',
    email: 'svc@x',
    password: 'pw',
  });

  assert.equal(cookies.length, 1, 'only the session cookie is returned');
  assert.ok(cookies[0].startsWith('next-auth.session-token=THEJWT'));

  // the credentials POST forwarded the csrf token + cookie, form-encoded
  const login = seen.find((s) => s.url.endsWith('/api/auth/callback/credentials'));
  assert.ok(login, 'called the credentials callback');
  assert.equal((login!.init!.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded');
  assert.ok(String((login!.init!.headers as Record<string, string>).cookie).includes('next-auth.csrf-token='));
  assert.ok(String(login!.init!.body).includes('csrfToken=csrf123'));
  assert.ok(String(login!.init!.body).includes('password=pw'));
});

test('loginLangfuse throws when no session cookie comes back', async () => {
  const fakeFetch = (async (url: string | URL) => {
    if (String(url).endsWith('/api/auth/csrf')) return res({ csrfToken: 't' }, []);
    return res({ error: 'bad creds' }, [], 401); // no session cookie
  }) as typeof fetch;
  await assert.rejects(
    () => loginLangfuse({ fetchImpl: fakeFetch, baseUrl: 'http://lf', email: 'a', password: 'b' }),
    /no session cookie/,
  );
});

/* --------------------------------------------------------- cached provider */

test('getLangfuseSessionCookies caches the login and fails soft to []', async () => {
  _resetLangfuseSessionCache();
  let calls = 0;
  const okFetch = (async (url: string | URL) => {
    calls++;
    if (String(url).endsWith('/api/auth/csrf')) return res({ csrfToken: 't' }, ['next-auth.csrf-token=c; Path=/']);
    return res({}, ['next-auth.session-token=JWT; Path=/; HttpOnly']);
  }) as typeof fetch;

  const first = await getLangfuseSessionCookies(okFetch);
  assert.equal(first.length, 1);
  const callsAfterFirst = calls;
  const second = await getLangfuseSessionCookies(okFetch);
  assert.deepEqual(second, first);
  assert.equal(calls, callsAfterFirst, 'second call served from cache — no new login');

  // failure path: reset, then a throwing fetch yields [] (proxy degrades to login)
  _resetLangfuseSessionCache();
  const badFetch = (async () => {
    throw new Error('unreachable');
  }) as typeof fetch;
  assert.deepEqual(await getLangfuseSessionCookies(badFetch), []);
});
