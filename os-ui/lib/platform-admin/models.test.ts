/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, listModels, getDefaults, setDefault, setEnabled, registerProviderKey, listProviderKeys } from './models.ts';

beforeEach(() => _reset());

test('listModels seeds catalog on first call', () => {
  const models = listModels();
  assert.ok(models.length > 0);
  assert.ok(models.some((m) => m.id === 'ministral-8b'));
});

test('setDefault rejects a mismatched task', () => {
  assert.throws(() => setDefault('embedding', 'ministral-8b'), (e: { status?: number }) => e.status === 400);
});

test('setEnabled blocks disabling a current default', () => {
  assert.throws(() => setEnabled('ministral-8b', false), (e: { status?: number }) => e.status === 409);
});

test('registerProviderKey stores ref+fingerprint only', () => {
  const pk = registerProviderKey({ provider: 'openai', ref: { name: 'sec', key: 'api_key' }, fingerprint: 'sha256:abc', addedBy: 'sara' });
  assert.equal(pk.fingerprint, 'sha256:abc');
  assert.equal((pk as Record<string, unknown>).value, undefined);
  assert.equal(listProviderKeys().length, 1);
});

test('globalThis pin: modelsState is shared under soa.platform.models', () => {
  listModels(); // trigger seed
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.models')] as { catalog: Map<string, unknown>; defaults: Record<string, string> };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.ok(pinned.catalog.size > 0, 'seeded catalog must appear in globalThis state');
  assert.equal(pinned.defaults.chat, getDefaults().chat, 'defaults must match');
});
