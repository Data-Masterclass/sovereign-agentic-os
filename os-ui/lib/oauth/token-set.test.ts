/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenSetFromResponse,
  serializeTokenSet,
  parseTokenSet,
  isExpired,
  buildAuthorizeUrl,
  exchangeBody,
  refreshBody,
} from './token-set.ts';
import { OAUTH_PROVIDERS, providerForTemplate, filesProviderFor, asOAuthProvider } from './providers.ts';

test('tokenSetFromResponse computes absolute expiry and carries the refresh token', () => {
  const ts = tokenSetFromResponse({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'x' }, 1000);
  assert.equal(ts?.accessToken, 'a1');
  assert.equal(ts?.refreshToken, 'r1');
  assert.equal(ts?.expiresAt, 4600);
  assert.equal(ts?.scope, 'x');
});

test('tokenSetFromResponse keeps the PRIOR refresh token when a refresh omits it (Google)', () => {
  const prev = { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 10 };
  const ts = tokenSetFromResponse({ access_token: 'a2', expires_in: 3600 }, 1000, prev);
  assert.equal(ts?.refreshToken, 'keep-me');
});

test('tokenSetFromResponse returns null without an access token', () => {
  assert.equal(tokenSetFromResponse({ expires_in: 60 }, 0), null);
});

test('parse round-trips a real token set but rejects the mock placeholder', () => {
  const ts = { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scope: 's', tokenType: 'Bearer' };
  const round = parseTokenSet(serializeTokenSet(ts));
  assert.deepEqual(round, ts);
  // the offline mock placeholder is an opaque non-JSON string → null (→ mock client)
  assert.equal(parseTokenSet('mock-oauth-oauth-token-abc123'), null);
  assert.equal(parseTokenSet(''), null);
  assert.equal(parseTokenSet(null), null);
  assert.equal(parseTokenSet('{"nope":1}'), null);
});

test('isExpired honours the skew window', () => {
  const ts = { accessToken: 'a', expiresAt: 1000 };
  assert.equal(isExpired(ts, 900), false);
  assert.equal(isExpired(ts, 941), true); // within 60s skew of 1000
  assert.equal(isExpired(ts, 1000), true);
});

test('buildAuthorizeUrl (Google) requests drive.readonly + offline consent', () => {
  const url = new URL(buildAuthorizeUrl(OAUTH_PROVIDERS.google, { clientId: 'cid', redirectUri: 'https://agentic.datamasterclass.com/api/connections/oauth/google/callback', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'st');
});

test('buildAuthorizeUrl (Microsoft) requests Files.Read + offline_access', () => {
  const url = new URL(buildAuthorizeUrl(OAUTH_PROVIDERS.microsoft, { clientId: 'cid', redirectUri: 'https://agentic.datamasterclass.com/api/connections/oauth/microsoft/callback', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('scope'), 'Files.Read offline_access');
});

test('exchange + refresh bodies carry the right grant types', () => {
  const ex = exchangeBody({ clientId: 'c', clientSecret: 's', code: 'code', redirectUri: 'r' });
  assert.equal(ex.get('grant_type'), 'authorization_code');
  assert.equal(ex.get('code'), 'code');
  const rf = refreshBody({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' });
  assert.equal(rf.get('grant_type'), 'refresh_token');
  assert.equal(rf.get('refresh_token'), 'rt');
});

test('template → provider → files-provider mapping', () => {
  assert.equal(providerForTemplate('gdrive'), 'google');
  assert.equal(providerForTemplate('onedrive'), 'microsoft');
  assert.equal(providerForTemplate('notion-mcp'), null);
  assert.equal(filesProviderFor('google'), 'google-drive');
  assert.equal(filesProviderFor('microsoft'), 'onedrive');
  assert.equal(asOAuthProvider('google'), 'google');
  assert.equal(asOAuthProvider('bogus'), null);
});
