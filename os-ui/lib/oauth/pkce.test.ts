/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomVerifier, challengeFor, createPkcePair } from './pkce.ts';

test('verifier is RFC-length, url-safe, and unique per call', () => {
  const a = randomVerifier();
  const b = randomVerifier();
  assert.notEqual(a, b, 'two verifiers must differ');
  assert.ok(a.length >= 43, 'verifier is at least 43 chars (RFC 7636)');
  assert.match(a, /^[A-Za-z0-9\-_]+$/, 'verifier is base64url (no padding)');
});

test('challenge equals base64url(SHA-256(verifier)) — S256', async () => {
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected, 'challenge is the S256 of the verifier');
});

test('createPkcePair returns a matching verifier/challenge/method', async () => {
  const pair = await createPkcePair();
  assert.equal(pair.method, 'S256');
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'));
});
