/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isHashed, assessPasswordStrength } from './password.ts';
import { generateMasterKey, normalizeMasterKey } from './recovery.ts';

test('passwords are scrypt-hashed, salted, and never stored in plaintext', async () => {
  const plain = 'Correct-Horse-9!battery';
  const hash = await hashPassword(plain);
  assert.ok(hash.startsWith('scrypt$'), 'uses scrypt format');
  assert.ok(!hash.includes(plain), 'plaintext password never appears in the hash');
  assert.ok(isHashed(hash));
  // Salted: the same password hashes to different values each time.
  const hash2 = await hashPassword(plain);
  assert.notEqual(hash, hash2, 'distinct salts → distinct hashes');
});

test('verifyPassword accepts the right password and rejects the wrong one', async () => {
  const hash = await hashPassword('Sup3r-Secret-Phrase!!');
  assert.equal(await verifyPassword('Sup3r-Secret-Phrase!!', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('Sup3r-Secret-Phrase!', hash), false);
  // Never throws on garbage input.
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('weak passwords are rejected; strong ones pass', () => {
  for (const weak of ['admin', 'password', 'short', '123456789012', 'aaaaaaaaaaaa']) {
    assert.equal(assessPasswordStrength(weak).ok, false, `should reject: ${weak}`);
  }
  // Contains the username → rejected.
  assert.equal(assessPasswordStrength('alice-Str0ng-Pass!!', 'alice').ok, false);
  // Genuinely strong.
  const strong = assessPasswordStrength('Tr0ub4dour&3-horses', 'bob');
  assert.equal(strong.ok, true);
  assert.ok(strong.score >= 3);
});

test('master recovery key is high-entropy, grouped, and normalises cleanly', () => {
  const k1 = generateMasterKey();
  const k2 = generateMasterKey();
  assert.notEqual(k1, k2, 'keys are random');
  assert.match(k1, /^[0-9A-Z]{4}(-[0-9A-Z]{2,4})+$/, 'dash-grouped base32');
  const raw = normalizeMasterKey(k1);
  assert.ok(!raw.includes('-'), 'dashes stripped on normalise');
  assert.ok(raw.length >= 28, '>=140 bits of base32 entropy');
  assert.equal(normalizeMasterKey(k1.toLowerCase()), raw, 'case-insensitive');
});

test('the recovery key is stored only as a hash (no plaintext at rest)', async () => {
  const key = generateMasterKey();
  const stored = await hashPassword(normalizeMasterKey(key));
  assert.ok(stored.startsWith('scrypt$'));
  assert.ok(!stored.includes(normalizeMasterKey(key)), 'plaintext key never in the stored hash');
  assert.equal(await verifyPassword(normalizeMasterKey(key), stored), true);
  assert.equal(await verifyPassword('AAAA-BBBB-CCCC', stored), false);
});
