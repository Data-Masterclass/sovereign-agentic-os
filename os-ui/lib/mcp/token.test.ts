/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signMcpToken, verifyMcpToken } from './token.ts';

const SECRET = 'unit-test-secret';

test('token: sign → verify round-trips the user id', () => {
  const token = signMcpToken('dan', SECRET);
  assert.ok(token.startsWith('soa_mcp_'));
  const payload = verifyMcpToken(token, SECRET);
  assert.equal(payload?.id, 'dan');
});

test('token: a tampered body is rejected', () => {
  const token = signMcpToken('dan', SECRET);
  const raw = token.slice('soa_mcp_'.length);
  const [, sig] = raw.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ id: 'admin', iat: 1 })).toString('base64url');
  assert.equal(verifyMcpToken(`soa_mcp_${forgedBody}.${sig}`, SECRET), null);
});

test('token: the wrong secret is rejected', () => {
  const token = signMcpToken('dan', SECRET);
  assert.equal(verifyMcpToken(token, 'other-secret'), null);
});

test('token: missing / malformed tokens are rejected', () => {
  assert.equal(verifyMcpToken(null, SECRET), null);
  assert.equal(verifyMcpToken('', SECRET), null);
  assert.equal(verifyMcpToken('not-a-token', SECRET), null);
  assert.equal(verifyMcpToken('soa_mcp_only-body-no-sig', SECRET), null);
});
