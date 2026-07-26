/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  putSecret,
  hasSecret,
  deleteSecret,
  isEgressAllowed,
  isExternal,
  isInternalTarget,
} from './secrets.ts';

test('globalThis pin: create survives a fresh vault() call', () => {
  const ref = putSecret('db', 'password', 's3cr3t');

  // Confirm item is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.secrets.vault')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has('db/password'), 'secret key visible via globalThis pin');

  // hasSecret() calls vault() afresh — must still return true.
  assert.equal(hasSecret(ref), true);

  deleteSecret(ref);
  assert.equal(pinned.has('db/password'), false, 'delete clears via pinned map');
});

// ---------------------------------------------------------- Egress SSRF guard --

test('SSRF: internal in-cluster / loopback targets are DENIED by default', () => {
  // Bare service name (query-tool:8080 → host "query-tool"): the classic SSRF.
  const q = isEgressAllowed('http://query-tool:8080');
  assert.equal(isInternalTarget('http://query-tool:8080'), true, 'query-tool is internal');
  assert.equal(q.allowed, false, 'bare in-cluster service name is denied');

  // Other well-known internal services must all be denied.
  for (const ep of [
    'http://trino:8080',
    'http://opa:8181',
    'http://minio:9000',
    'https://kubernetes.default.svc',
    'http://svc.cluster.local',
    'http://foo.svc',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'http://[fe80::1]',
  ]) {
    assert.equal(isEgressAllowed(ep).allowed, false, `${ep} must be denied`);
    assert.equal(isInternalTarget(ep), true, `${ep} must be classified internal`);
  }
});

test('IPv6 loopback ::1 is denied', () => {
  assert.equal(isInternalTarget('http://[::1]:9000'), true);
  assert.equal(isEgressAllowed('http://[::1]:9000').allowed, false);
});

test('.svc in-cluster hostname is denied', () => {
  assert.equal(isInternalTarget('https://polaris.default.svc'), true);
  assert.equal(isEgressAllowed('https://polaris.default.svc').allowed, false);
});

test('allowlisted external host is allowed (external:true)', () => {
  const r = isEgressAllowed('https://api.github.com/user');
  assert.equal(isExternal('https://api.github.com/user'), true);
  assert.equal(r.external, true);
  assert.equal(r.allowed, true, 'a default-allowlisted external host passes');
});

test('non-allowlisted external host is denied', () => {
  const r = isEgressAllowed('https://evil.example.org');
  assert.equal(r.external, true);
  assert.equal(r.allowed, false, 'an unlisted external host is refused');
});

test('an INTERNAL host explicitly on the allowlist is allowed (escape hatch)', () => {
  const prev = process.env.OS_EGRESS_ALLOWLIST;
  process.env.OS_EGRESS_ALLOWLIST = 'query-tool,example.com';
  try {
    const r = isEgressAllowed('http://query-tool:8080');
    assert.equal(r.allowed, true, 'an operator-allowlisted internal host is permitted');
    assert.equal(r.external, false, 'still classified internal');
    // A non-listed internal host stays denied even with an allowlist present.
    assert.equal(isEgressAllowed('http://trino:8080').allowed, false);
  } finally {
    if (prev === undefined) delete process.env.OS_EGRESS_ALLOWLIST;
    else process.env.OS_EGRESS_ALLOWLIST = prev;
  }
});
