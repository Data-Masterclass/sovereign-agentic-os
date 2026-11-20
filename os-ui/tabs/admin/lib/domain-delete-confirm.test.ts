/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete-domain human gate: session-bound, single-use, short-lived confirmation
 * USER STORY: As the admin I want a run to need the token my own signed-in browser got for this
 *             domain a moment ago, and a script with forged browser headers to be refused.
 * ARCHITECTURE:
 *   - Real HMAC with a test secret; the same functions the route calls. Each case has a twin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHumanSession, consumeConfirmToken, issueConfirmToken, CONFIRM_TTL_MS } from '@tabs/admin/lib/domain-delete-confirm';

const secret = 'test-secret-for-confirm-tokens-0123456789';
const b = { userId: 'alex', sessionCookie: 'cookie-A', domainId: 'kiekert' };

test('the token from this session, for this domain, runs once', () => {
  const { token } = issueConfirmToken(b, { secret });
  consumeConfirmToken(token, b, { secret });
  assert.throws(() => consumeConfirmToken(token, b, { secret }), /already used/);
});

test('twins: another session, another domain, another user, expired, tampered — all refused', () => {
  const now = Date.now();
  const mk = () => issueConfirmToken(b, { secret, now }).token;
  assert.throws(() => consumeConfirmToken(mk(), { ...b, sessionCookie: 'cookie-B' }, { secret, now }), /not for this session/);
  assert.throws(() => consumeConfirmToken(mk(), { ...b, domainId: 'other' }, { secret, now }), /not for this session/);
  assert.throws(() => consumeConfirmToken(mk(), { ...b, userId: 'mallory' }, { secret, now }), /not for this session/);
  assert.throws(() => consumeConfirmToken(mk(), b, { secret, now: now + CONFIRM_TTL_MS + 1 }), /expired/);
  const t = mk();
  assert.throws(() => consumeConfirmToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), b, { secret, now }), /not for this session/);
  assert.throws(() => consumeConfirmToken(undefined, b, { secret, now }), /token .* is required/);
});

test('a non-browser client with forged browser headers is refused: a bearer, or no session cookie', () => {
  const forged = new Headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', origin: 'https://os.example', authorization: 'Bearer sk-agent' });
  assert.throws(() => assertHumanSession(forged, 'cookie-A'), /bearer/);
  const noCookie = new Headers({ 'sec-fetch-site': 'same-origin', origin: 'https://os.example' });
  assert.throws(() => assertHumanSession(noCookie, undefined), /no signed-in browser session/);
  // and without a token it cannot run even with the cookie and perfect headers
  assert.throws(() => consumeConfirmToken(undefined, b, { secret }), /required/);
  // twin: the cookie session with no bearer passes the session check
  assert.doesNotThrow(() => assertHumanSession(new Headers(), 'cookie-A'));
});
