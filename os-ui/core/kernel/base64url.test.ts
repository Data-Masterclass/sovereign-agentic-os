/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Characterisation of the shared base64url helper
 * USER STORY: As a maintainer merging five private base64url copies into one, I want proof the
 *             shared one gives byte-identical output to the Buffer-based copy it replaced.
 * ARCHITECTURE:
 *   - Compares against Node's own `Buffer#toString('base64')` with the same three replaces the
 *     removed GCP/Snowflake copies used, over random bytes of every padding length.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { b64urlDecode, b64urlEncode, base64url } from '@core/kernel/base64url';

const legacyBuffer = (input: Buffer | string) =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

test('base64url matches the removed Buffer copies for bytes and UTF-8 strings', () => {
  for (let n = 0; n < 64; n++) {
    const b = randomBytes(n);
    assert.equal(base64url(b), legacyBuffer(b));
    assert.equal(b64urlEncode(new Uint8Array(b)), legacyBuffer(b));
  }
  for (const s of ['', 'a', '{"alg":"RS256","typ":"JWT"}', 'Grüße · ✓ ~?>']) assert.equal(base64url(s), legacyBuffer(s));
});

test('b64urlDecode inverts b64urlEncode and accepts padded input', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(randomBytes(n));
    assert.deepEqual(b64urlDecode(b64urlEncode(b)), b);
  }
  assert.deepEqual(b64urlDecode('YQ=='), new Uint8Array([97]));
});
