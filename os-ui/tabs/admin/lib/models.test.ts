/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _reset, getDefaults, registerProviderKey, listProviderKeys,
  getAssistantModel, getAssistantModelId, setAssistantModel, clearAssistantModel, clearAssistantIf, isAssistantExplicit,
} from '@tabs/admin/lib/models';
import { _reset as resetSettings } from '@tabs/admin/lib/settings';

beforeEach(() => { _reset(); resetSettings(); });

test('getDefaults projects the ONE role store (settings modelRoles via roles.ts)', () => {
  // Unset roles → the config baselines; there is no separate defaults record.
  assert.equal(getDefaults().chat, 'sovereign-default');
  assert.equal(getDefaults().reasoning, 'sovereign-reasoning');
  assert.equal(getDefaults().embedding, 'sovereign-embed');
});

test('registerProviderKey stores ref+fingerprint only', () => {
  const pk = registerProviderKey({ provider: 'openai', ref: { name: 'sec', key: 'api_key' }, fingerprint: 'sha256:abc', addedBy: 'sara' });
  assert.equal(pk.fingerprint, 'sha256:abc');
  assert.equal((pk as Record<string, unknown>).value, undefined);
  assert.equal(listProviderKeys().length, 1);
});

test('assistant follows the STANDARD role out of the box (no explicit override)', () => {
  assert.equal(getAssistantModelId(), 'sovereign-default');
  assert.equal(getAssistantModel()?.id, 'sovereign-default');
  assert.equal(isAssistantExplicit(), false);
});

test('an explicit assistant pin is held until cleared; clearing goes back to follow-Standard', () => {
  assert.equal(setAssistantModel('acme-chat'), 'acme-chat');
  assert.equal(isAssistantExplicit(), true);
  assert.equal(getAssistantModelId(), 'acme-chat');
  clearAssistantModel();
  assert.equal(isAssistantExplicit(), false);
  assert.equal(getAssistantModelId(), 'sovereign-default');
});

test('NEGATIVE TWIN: a blank alias is refused (400) and changes nothing', () => {
  assert.throws(() => setAssistantModel('   '), (e: { status?: number }) => e.status === 400);
  assert.equal(isAssistantExplicit(), false);
});

test('after a model is removed in LiteLLM a pin at it goes back to follow-Standard; a pin at another model stays', () => {
  setAssistantModel('acme-chat');
  assert.equal(clearAssistantIf('some-other-model'), false);
  assert.equal(getAssistantModelId(), 'acme-chat');
  assert.equal(clearAssistantIf('acme-chat'), true);
  assert.equal(isAssistantExplicit(), false);
  assert.equal(getAssistantModelId(), 'sovereign-default', 'never a ghost pin');
});

test('globalThis pin: the state is shared under soa.platform.models and holds no catalog', () => {
  setAssistantModel('acme-chat');
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.models')] as Record<string, unknown>;
  assert.ok(pinned, 'state must be present on globalThis');
  assert.equal(pinned.assistant, 'acme-chat');
  assert.equal('catalog' in pinned, false, 'no model catalog is kept in the OS');
});
