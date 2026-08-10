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
  isHardDeniedTarget,
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

// -------------------------------------- SSRF: hard-denied metadata/loopback --

test('SSRF: cloud-metadata 169.254.169.254 is DENIED even if explicitly allowlisted', () => {
  const prev = process.env.OS_EGRESS_ALLOWLIST;
  // Attacker tries to allowlist the metadata IP outright.
  process.env.OS_EGRESS_ALLOWLIST = '169.254.169.254,example.com';
  try {
    assert.equal(isHardDeniedTarget('http://169.254.169.254/latest/meta-data/'), true);
    assert.equal(isEgressAllowed('http://169.254.169.254/latest/meta-data/').allowed, false,
      'the cloud-metadata endpoint is never egressable, allowlist or not');
    assert.equal(isInternalTarget('http://169.254.169.254/'), true);
    // whole link-local /16 is hard-denied
    assert.equal(isEgressAllowed('http://169.254.10.20/').allowed, false);
  } finally {
    if (prev === undefined) delete process.env.OS_EGRESS_ALLOWLIST;
    else process.env.OS_EGRESS_ALLOWLIST = prev;
  }
});

test('SSRF: loopback 127.0.0.1 is DENIED even if explicitly allowlisted', () => {
  const prev = process.env.OS_EGRESS_ALLOWLIST;
  process.env.OS_EGRESS_ALLOWLIST = '127.0.0.1';
  try {
    assert.equal(isHardDeniedTarget('http://127.0.0.1:8080'), true);
    assert.equal(isEgressAllowed('http://127.0.0.1:8080').allowed, false);
    assert.equal(isHardDeniedTarget('http://127.9.9.9/'), true, 'whole 127.0.0.0/8');
    assert.equal(isEgressAllowed('http://[::1]:9000').allowed, false, 'IPv6 loopback hard-denied too');
    assert.equal(isHardDeniedTarget('http://[::1]:9000'), true);
  } finally {
    if (prev === undefined) delete process.env.OS_EGRESS_ALLOWLIST;
    else process.env.OS_EGRESS_ALLOWLIST = prev;
  }
});

test('SSRF: IPv4-mapped-IPv6 loopback/metadata forms are hard-denied', () => {
  assert.equal(isHardDeniedTarget('http://[::ffff:127.0.0.1]/'), true);
  assert.equal(isHardDeniedTarget('http://[::ffff:169.254.169.254]/'), true);
  // hex-tail mapped forms: 7f00:0001 = 127.0.0.1 ; a9fe:a9fe = 169.254.169.254
  assert.equal(isHardDeniedTarget('http://[::ffff:7f00:1]/'), true);
  assert.equal(isHardDeniedTarget('http://[::ffff:a9fe:a9fe]/'), true);
  assert.equal(isEgressAllowed('http://[::ffff:169.254.169.254]/').allowed, false);
});

test('RFC1918: an allowlisted 10.x on-prem host is STILL permitted (not hard-denied)', () => {
  const prev = process.env.OS_EGRESS_ALLOWLIST;
  process.env.OS_EGRESS_ALLOWLIST = '10.20.30.40';
  try {
    assert.equal(isHardDeniedTarget('http://10.20.30.40:8443'), false, 'RFC1918 is not hard-denied');
    assert.equal(isInternalTarget('http://10.20.30.40:8443'), true, 'RFC1918 classified internal (allowlist-gated)');
    const r = isEgressAllowed('http://10.20.30.40:8443');
    assert.equal(r.allowed, true, 'an explicitly allowlisted private warehouse stays reachable');
    assert.equal(r.external, false);
    // A non-allowlisted RFC1918 host is still denied by default.
    assert.equal(isEgressAllowed('http://192.168.1.5/').allowed, false);
    assert.equal(isEgressAllowed('http://172.16.0.9/').allowed, false);
  } finally {
    if (prev === undefined) delete process.env.OS_EGRESS_ALLOWLIST;
    else process.env.OS_EGRESS_ALLOWLIST = prev;
  }
});

test('RFC1918 boundary: 172.15/172.32 are PUBLIC (outside 172.16-31), not internal', () => {
  assert.equal(isInternalTarget('http://172.15.0.1/'), false);
  assert.equal(isInternalTarget('http://172.32.0.1/'), false);
  assert.equal(isInternalTarget('http://172.16.0.1/'), true);
  assert.equal(isInternalTarget('http://172.31.255.255/'), true);
});
