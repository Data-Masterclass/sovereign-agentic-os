/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putSecret } from '@/lib/infra/secrets';
import { storeTokens, readTokens, resolveAccessToken } from './connection-token.ts';
import type { TokenSet } from './token-set.ts';

const ref = (n: string) => ({ name: `connection-${n}`, key: 'oauth-token' });

test('a fresh token resolves live without refreshing', async () => {
  const r = ref('fresh');
  storeTokens(r, { accessToken: 'tok-fresh', refreshToken: 'rt', expiresAt: 10_000 });
  const res = await resolveAccessToken(r, 'google', { now: 1000 });
  assert.equal(res.status, 'live');
  if (res.status === 'live') {
    assert.equal(res.accessToken, 'tok-fresh');
    assert.equal(res.refreshed, false);
  }
});

test('an expired token is silently refreshed and re-stored', async () => {
  const r = ref('stale');
  storeTokens(r, { accessToken: 'old', refreshToken: 'rt-1', expiresAt: 500 });
  let called = 0;
  const refresh = async (_p: string, prev: TokenSet): Promise<TokenSet> => {
    called++;
    assert.equal(prev.refreshToken, 'rt-1');
    return { accessToken: 'new-access', refreshToken: 'rt-1', expiresAt: 9999 };
  };
  const res = await resolveAccessToken(r, 'google', { now: 1000, refresh });
  assert.equal(called, 1);
  assert.equal(res.status, 'live');
  if (res.status === 'live') {
    assert.equal(res.accessToken, 'new-access');
    assert.equal(res.refreshed, true);
  }
  // the refreshed token set was written back to the same ref
  assert.equal(readTokens(r)?.accessToken, 'new-access');
});

test('expired with no refresh token → needs-reconnect (no refresh attempted)', async () => {
  const r = ref('norefresh');
  storeTokens(r, { accessToken: 'old', expiresAt: 500 });
  const res = await resolveAccessToken(r, 'microsoft', { now: 1000, refresh: async () => { throw new Error('should not be called'); } });
  assert.equal(res.status, 'needs-reconnect');
});

test('a failed refresh surfaces needs-reconnect (never throws into the sync)', async () => {
  const r = ref('badrefresh');
  storeTokens(r, { accessToken: 'old', refreshToken: 'rt', expiresAt: 500 });
  const res = await resolveAccessToken(r, 'google', { now: 1000, refresh: async () => { throw new Error('invalid_grant'); } });
  assert.equal(res.status, 'needs-reconnect');
  if (res.status === 'needs-reconnect') assert.match(res.reason, /invalid_grant/);
});

test('the offline mock placeholder (non-JSON) resolves to none → mock client', async () => {
  const r = ref('mock');
  putSecret(r.name, r.key, 'mock-oauth-oauth-token-deadbeef'); // what createConnection stores offline
  const res = await resolveAccessToken(r, 'google', { now: 1000 });
  assert.equal(res.status, 'none');
});
