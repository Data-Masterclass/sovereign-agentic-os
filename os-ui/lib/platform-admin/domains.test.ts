/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, createDomain, listDomains, getDomain } from './domains.ts';

beforeEach(() => _reset());

test('cross-instance: domain writes are visible through globalThis symbol', () => {
  const d = createDomain({ name: 'Engineering', owner: 'admin' });
  const raw = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.domains')] as { store: Map<string, unknown> };
  assert.ok(raw && raw.store.has(d.id), 'record visible in globalThis state');
  assert.equal(listDomains().length, 1);
  assert.equal(getDomain(d.id).name, 'Engineering');
});
