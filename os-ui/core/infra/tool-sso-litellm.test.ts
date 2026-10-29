/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasLiteLlmSession, cookiePair, sessionCookiesFrom, loginLiteLlm,
  getLiteLlmSessionCookies, _resetLiteLlmSessionCache, liteLlmSsoConfigured,
} from './tool-sso-litellm.ts';
import { config } from '@core/kernel/config';

const withCreds = (fn: () => Promise<void> | void) => async () => {
  const c = config as { litellmUiUsername: string; litellmUiPassword: string };
  const u = c.litellmUiUsername, p = c.litellmUiPassword;
  c.litellmUiUsername = 'ui-admin'; c.litellmUiPassword = 'ui-secret';
  _resetLiteLlmSessionCache();
  try { await fn(); } finally { c.litellmUiUsername = u; c.litellmUiPassword = p; _resetLiteLlmSessionCache(); }
};

test('LITELLM-SSO: detects an existing session cookie', () => {
  assert.equal(hasLiteLlmSession('token=abc; other=1'), true);
  assert.equal(hasLiteLlmSession('litellm_session=abc'), true);
  assert.equal(hasLiteLlmSession('unrelated=1'), false);
  assert.equal(hasLiteLlmSession(null), false);
});

test('LITELLM-SSO: only session cookies are forwarded, attributes stripped', () => {
  const raw = ['token=abc; Path=/; HttpOnly', 'ajs_anonymous_id=nope; Path=/'];
  assert.deepEqual(sessionCookiesFrom(raw).map(cookiePair), ['token=abc']);
});

test('LITELLM-SSO: the credential is posted SERVER-SIDE and never returned', withCreds(async () => {
  const seen: { url?: string; body?: string; ct?: string } = {};
  const fake: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.body = String(init?.body ?? '');
    seen.ct = String((init?.headers as Record<string, string>)?.['content-type'] ?? '');
    return new Response('', { status: 302, headers: { 'set-cookie': 'token=jwt-value; Path=/; HttpOnly' } });
  }) as typeof fetch;

  const cookies = await getLiteLlmSessionCookies(fake);
  assert.deepEqual(cookies, ['token=jwt-value'], 'returns only the session cookie');
  assert.match(seen.url!, /\/login$/, 'posts to the UI login route');
  assert.match(seen.ct!, /x-www-form-urlencoded/, 'form-encoded, as the HTML route expects');
  assert.match(seen.body!, /username=ui-admin/);
  // The decisive assertion: the credential does not travel back to the caller.
  for (const c of cookies) assert.doesNotMatch(c, /ui-secret/, 'the password must never appear in the cookie');
}));

test('LITELLM-SSO: a failed login degrades to no cookie — never throws at the caller', withCreds(async () => {
  const fake: typeof fetch = (async () => new Response('bad creds', { status: 401 })) as typeof fetch;
  assert.deepEqual(await getLiteLlmSessionCookies(fake), [], 'no session, no exception');
}));

test('LITELLM-SSO: an unreachable gateway degrades to no cookie', withCreds(async () => {
  const fake: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  assert.deepEqual(await getLiteLlmSessionCookies(fake), []);
}));

test('LITELLM-SSO: with no UI credential configured nothing is attempted', async () => {
  const c = config as { litellmUiUsername: string; litellmUiPassword: string };
  const u = c.litellmUiUsername, p = c.litellmUiPassword;
  c.litellmUiUsername = ''; c.litellmUiPassword = '';
  _resetLiteLlmSessionCache();
  let called = false;
  const fake: typeof fetch = (async () => { called = true; return new Response('', { status: 200 }); }) as typeof fetch;
  try {
    assert.deepEqual(await getLiteLlmSessionCookies(fake), []);
    assert.equal(called, false, 'no login attempt without a credential');
    assert.equal(liteLlmSsoConfigured(), false, 'the UI can say so honestly');
  } finally { c.litellmUiUsername = u; c.litellmUiPassword = p; _resetLiteLlmSessionCache(); }
});

test('LITELLM-SSO: loginLiteLlm throws when the response carries no session cookie', async () => {
  const fake: typeof fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => loginLiteLlm({ baseUrl: 'http://x', username: 'a', password: 'b', fetchImpl: fake }),
    /no session cookie/,
  );
});
