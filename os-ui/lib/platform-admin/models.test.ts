/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _reset, listModels, getDefaults, setDefault, setEnabled, registerProviderKey, listProviderKeys,
  registerAssistantModel, getAssistantModel, getAssistantModelId, setAssistantModel,
} from './models.ts';

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

test('assistant model defaults to the sovereign chat model out of the box', () => {
  assert.equal(getAssistantModelId(), 'ministral-8b');
  assert.equal(getAssistantModel()?.id, 'ministral-8b');
});

test('registerAssistantModel stores endpoint ref + fingerprint, never a raw key', () => {
  const m = registerAssistantModel({
    id: 'stackit-managed',
    label: 'STACKIT managed LLM',
    endpoint: { baseUrl: 'https://llm.stackit/v1', modelName: 'stackit-chat', keyRef: { name: 'model-stackit-managed', key: 'api_key' }, fingerprint: 'sha256:deadbeef' },
    addedBy: 'sara',
  });
  assert.equal(m.task, 'chat');
  assert.equal(m.tier, 'premium');
  assert.equal(m.endpoint?.fingerprint, 'sha256:deadbeef');
  // The endpoint carries only a ref + fingerprint — no raw key field exists.
  assert.equal((m.endpoint as unknown as Record<string, unknown>).apiKey, undefined);
  assert.equal((m.endpoint as unknown as Record<string, unknown>).value, undefined);
  assert.ok(listModels().some((x) => x.id === 'stackit-managed'));
});

test('setAssistantModel points the ONE assistant at the registered model', () => {
  registerAssistantModel({ id: 'stackit-managed', label: 'STACKIT', endpoint: { baseUrl: 'https://x/v1', modelName: 'm', keyRef: { name: 'n', key: 'k' }, fingerprint: 'sha256:1' }, addedBy: 'sara' });
  setAssistantModel('stackit-managed');
  assert.equal(getAssistantModelId(), 'stackit-managed');
  assert.equal(getAssistantModel()?.id, 'stackit-managed');
});

test('setAssistantModel rejects unknown, non-chat and disabled models', () => {
  assert.throws(() => setAssistantModel('nope'), (e: { status?: number }) => e.status === 404);
  assert.throws(() => setAssistantModel('magistral-small'), (e: { status?: number }) => e.status === 400); // reasoning, not chat
});

test('setEnabled blocks disabling the current assistant model', () => {
  registerAssistantModel({ id: 'sm', label: 'SM', endpoint: { baseUrl: 'https://x/v1', modelName: 'm', keyRef: { name: 'n', key: 'k' }, fingerprint: 'sha256:1' }, addedBy: 'sara' });
  setAssistantModel('sm');
  assert.throws(() => setEnabled('sm', false), (e: { status?: number }) => e.status === 409);
});

test('globalThis pin: modelsState is shared under soa.platform.models', () => {
  listModels(); // trigger seed
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.models')] as { catalog: Map<string, unknown>; defaults: Record<string, string> };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.ok(pinned.catalog.size > 0, 'seeded catalog must appear in globalThis state');
  assert.equal(pinned.defaults.chat, getDefaults().chat, 'defaults must match');
});
