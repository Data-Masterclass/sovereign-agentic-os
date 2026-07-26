/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, roleAtLeast } from './session.ts';

/**
 * Real session cryptography tests — no mocking of the crypto path.
 *
 * Uses the real signSession / verifySession helpers (Web Crypto HMAC-SHA256).
 * Tamper one byte → rejected. Expired timestamp → rejected.
 */

const SECRET = 'test-secret-for-unit-testing-only-32chars!';

const CLAIMS = {
  id: 'amir',
  name: 'Amir Test',
  domains: ['sales'],
  role: 'creator' as const,
};

test('a genuinely signed token verifies successfully', async () => {
  const token = await signSession(CLAIMS, SECRET);
  assert.ok(token, 'signSession returns a token');
  assert.ok(token.includes('.'), 'token has the payload.sig format');

  const claims = await verifySession(token, SECRET);
  assert.ok(claims, 'valid token verifies');
  assert.equal(claims!.id, CLAIMS.id);
  assert.equal(claims!.name, CLAIMS.name);
  assert.equal(claims!.role, CLAIMS.role);
  assert.deepEqual(claims!.domains, CLAIMS.domains);
  assert.ok(typeof claims!.iat === 'number' && claims!.iat > 0, 'iat is stamped');
});

test('tampered token (one byte flipped in payload) is rejected', async () => {
  const token = await signSession(CLAIMS, SECRET);
  // Flip one character in the payload portion (before the dot)
  const [body, sig] = token.split('.');
  const tamperedBody = body!.slice(0, -1) + (body!.at(-1) === 'a' ? 'b' : 'a');
  const tampered = `${tamperedBody}.${sig}`;

  const result = await verifySession(tampered, SECRET);
  assert.equal(result, null, 'tampered token must be rejected');
});

test('tampered token (signature replaced with all-zeros) is rejected', async () => {
  const token = await signSession(CLAIMS, SECRET);
  const [body] = token.split('.');
  // Replace the entire signature with a known-wrong value (44 'A' chars ≈ 32 zero bytes in base64url).
  const fakesSig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const tampered = `${body}.${fakesSig}`;

  const result = await verifySession(tampered, SECRET);
  assert.equal(result, null, 'token with replaced signature must be rejected');
});

test('expired token is rejected (iat outside 12-hour window)', async () => {
  // Manually craft a token with an expired iat (more than 12 h ago).
  const expiredClaims = { ...CLAIMS, iat: Math.floor(Date.now() / 1000) - 60 * 60 * 13 }; // 13h ago
  // Encode manually: base64url(JSON(claims)).base64url(sig)
  const enc = new TextEncoder();
  const b64urlEncode = (bytes: Uint8Array) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(expiredClaims)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const token = `${body}.${b64urlEncode(sigBytes)}`;

  const result = await verifySession(token, SECRET);
  assert.equal(result, null, 'expired token (13h old) must be rejected');
});

test('missing or malformed tokens return null, never throw', async () => {
  assert.equal(await verifySession(null, SECRET), null);
  assert.equal(await verifySession(undefined, SECRET), null);
  assert.equal(await verifySession('', SECRET), null);
  assert.equal(await verifySession('notavalidtoken', SECRET), null);
  assert.equal(await verifySession('no.dots.here.extra', SECRET), null);
});

test('wrong secret rejects a token signed with a different secret', async () => {
  const token = await signSession(CLAIMS, SECRET);
  const result = await verifySession(token, 'completely-different-secret-value!');
  assert.equal(result, null, 'token signed with a different secret must be rejected');
});

// roleAtLeast floor check (defined in this module — pinned here too)
test('roleAtLeast is the single correct floor predicate (no exact-set bugs)', () => {
  assert.equal(roleAtLeast('creator', 'creator'), true);
  assert.equal(roleAtLeast('builder', 'creator'), true);
  assert.equal(roleAtLeast('domain_admin', 'builder'), true, 'domain_admin ≥ builder');
  assert.equal(roleAtLeast('admin', 'domain_admin'), true);
  assert.equal(roleAtLeast('creator', 'builder'), false);
  assert.equal(roleAtLeast('builder', 'domain_admin'), false);
  assert.equal(roleAtLeast('domain_admin', 'admin'), false);
  // Unknown role → creator (rank 0) → fails any floor above creator
  assert.equal(roleAtLeast('agentic-leader' as never, 'builder'), false);
});
