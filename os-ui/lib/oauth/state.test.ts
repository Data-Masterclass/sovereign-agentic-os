/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signState, verifyState, newNonce, nonceMatches } from './state.ts';

const SECRET = 'test-secret-for-oauth-state';

test('signState → verifyState round-trips the payload', async () => {
  const nonce = newNonce();
  const token = await signState({ connectionId: 'conn_1', userId: 'amir', provider: 'google', nonce }, SECRET);
  const s = await verifyState(token, SECRET);
  assert.equal(s?.connectionId, 'conn_1');
  assert.equal(s?.userId, 'amir');
  assert.equal(s?.provider, 'google');
  assert.equal(s?.nonce, nonce);
});

test('a tampered payload fails verification (CSRF)', async () => {
  const token = await signState({ connectionId: 'conn_1', userId: 'amir', provider: 'google', nonce: 'n' }, SECRET);
  const [body, sig] = token.split('.');
  // flip the payload but keep the old signature
  const forged = `${body}x.${sig}`;
  assert.equal(await verifyState(forged, SECRET), null);
});

test('a wrong secret fails verification', async () => {
  const token = await signState({ connectionId: 'c', userId: 'u', provider: 'google', nonce: 'n' }, SECRET);
  assert.equal(await verifyState(token, 'other-secret'), null);
});

test('an expired state is rejected', async () => {
  const token = await signState({ connectionId: 'c', userId: 'u', provider: 'google', nonce: 'n' }, SECRET);
  // ttl of 0 seconds → anything older than "now" is expired
  assert.equal(await verifyState(token, SECRET, -1), null);
});

test('nonceMatches is exact and null-safe (double-submit check)', () => {
  const n = newNonce();
  assert.equal(nonceMatches(n, n), true);
  assert.equal(nonceMatches(n, n + 'x'), false);
  assert.equal(nonceMatches(n, undefined), false);
  assert.equal(nonceMatches(undefined, undefined), false);
});
