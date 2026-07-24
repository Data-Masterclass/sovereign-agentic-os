/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDomainScope } from './active-domain.ts';

const ALL = ['kiekert', 'europace', 'test'];

test('a valid requested domain narrows the scope to just that domain', () => {
  const s = resolveDomainScope(ALL, 'kiekert');
  assert.deepEqual(s.domains, ['kiekert']);
  assert.equal(s.activeDomain, 'kiekert');
  assert.deepEqual(s.allDomains, ALL);
});

test('no request = all domains (activeDomain null)', () => {
  for (const req of [null, undefined, '']) {
    const s = resolveDomainScope(ALL, req);
    assert.deepEqual(s.domains, ALL);
    assert.equal(s.activeDomain, null);
  }
});

test('a non-member (stale/forged) request is ignored — cannot escalate', () => {
  const s = resolveDomainScope(ALL, 'acme-secret');
  assert.deepEqual(s.domains, ALL);
  assert.equal(s.activeDomain, null);
});

test('single-domain user: a valid pick still works', () => {
  const s = resolveDomainScope(['solo'], 'solo');
  assert.deepEqual(s.domains, ['solo']);
  assert.equal(s.activeDomain, 'solo');
});
