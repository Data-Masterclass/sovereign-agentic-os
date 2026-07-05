/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signMcpToken, signMcpPayload, verifyMcpToken } from './token.ts';

const SECRET = 'unit-test-secret';
const NOW = Math.floor(Date.now() / 1000);

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

test('token: an OAuth access token carries aud/exp/scope/typ through verify', () => {
  const token = signMcpPayload({ id: 'dan', typ: 'access', aud: 'https://x/api/mcp', exp: NOW + 3600, scope: 'mcp:tools' }, SECRET);
  const p = verifyMcpToken(token, SECRET);
  assert.equal(p?.id, 'dan');
  assert.equal(p?.typ, 'access');
  assert.equal(p?.aud, 'https://x/api/mcp');
  assert.equal(p?.scope, 'mcp:tools');
});

test('token: exp is enforced only when present — expired is rejected, legacy (no exp) still verifies', () => {
  const expired = signMcpPayload({ id: 'dan', exp: NOW - 1 }, SECRET);
  assert.equal(verifyMcpToken(expired, SECRET), null);
  const legacy = signMcpToken('dan', SECRET); // no exp — the copy-paste bearer path
  assert.equal(verifyMcpToken(legacy, SECRET)?.id, 'dan');
});
