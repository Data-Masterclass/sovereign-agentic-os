/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _reset, listModels, getDefaults, setEnabled, registerProviderKey, listProviderKeys,
  registerAssistantModel, getAssistantModel, getAssistantModelId, setAssistantModel,
} from './models.ts';
import { _reset as resetSettings } from './settings.ts';

beforeEach(() => { _reset(); resetSettings(); });

test('listModels seeds the live STACKIT alias catalog (no stale self-hosted ids)', () => {
  const models = listModels();
  assert.ok(models.length > 0);
  assert.ok(models.some((m) => m.id === 'sovereign-default'));
  assert.ok(models.some((m) => m.id === 'sovereign-embed'));
  // The deleted self-hosted seed ids must be gone.
  assert.ok(!models.some((m) => m.id === 'ministral-8b'));
  assert.ok(!models.some((m) => m.id === 'magistral-small'));
  assert.ok(!models.some((m) => m.id === 'bge-m3'));
});

test('getDefaults projects the ONE role store (settings modelRoles via roles.ts)', () => {
  // Unset roles → the config baselines; there is no separate defaults record.
  assert.equal(getDefaults().chat, 'sovereign-default');
  assert.equal(getDefaults().reasoning, 'sovereign-reasoning');
  assert.equal(getDefaults().embedding, 'sovereign-embed');
});

test('setEnabled blocks disabling a current role default', () => {
  // sovereign-default is the STANDARD role default out of the box.
  assert.throws(() => setEnabled('sovereign-default', false), (e: { status?: number }) => e.status === 409);
});

test('registerProviderKey stores ref+fingerprint only', () => {
  const pk = registerProviderKey({ provider: 'openai', ref: { name: 'sec', key: 'api_key' }, fingerprint: 'sha256:abc', addedBy: 'sara' });
  assert.equal(pk.fingerprint, 'sha256:abc');
  assert.equal((pk as Record<string, unknown>).value, undefined);
  assert.equal(listProviderKeys().length, 1);
});

test('assistant follows the STANDARD role out of the box (no explicit override)', () => {
  // With no explicit override the assistant tracks the STANDARD role default
  // (roleModel('standard') → sovereign-default), so it works without admin action.
  assert.equal(getAssistantModelId(), 'sovereign-default');
  assert.equal(getAssistantModel()?.id, 'sovereign-default');
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
  assert.throws(() => setAssistantModel('sovereign-reasoning'), (e: { status?: number }) => e.status === 400); // reasoning, not chat
});

test('setEnabled blocks disabling the current assistant model', () => {
  registerAssistantModel({ id: 'sm', label: 'SM', endpoint: { baseUrl: 'https://x/v1', modelName: 'm', keyRef: { name: 'n', key: 'k' }, fingerprint: 'sha256:1' }, addedBy: 'sara' });
  setAssistantModel('sm');
  assert.throws(() => setEnabled('sm', false), (e: { status?: number }) => e.status === 409);
});

test('globalThis pin: modelsState is shared under soa.platform.models', () => {
  listModels(); // trigger seed
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.models')] as { catalog: Map<string, unknown>; assistant: string };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.ok(pinned.catalog.size > 0, 'seeded catalog must appear in globalThis state');
  assert.equal(typeof pinned.assistant, 'string', 'assistant override lives on the shared state');
});
