/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The model list is LiteLLM's: one row per alias, read live from `/model/info`, with the
 *             connections (LiteLLM credentials) behind it and who manages each model.
 * USER STORY: As a platform admin I add or remove a model in LiteLLM and the OS shows exactly that —
 *             which models the deployment's config file sets, which live in LiteLLM's database, and
 *             which connection each uses — without the OS keeping a list of its own.
 * ARCHITECTURE:
 *   - Pure mapping over rows LiteLLM returned, plus the injected reads (`readGatewayCatalog`). No
 *     seed, no cache, no fallback: a gateway that cannot be read is `{ ok: false }`, never an
 *     invented list.
 *   - NEGATIVE TWINS: credential VALUES must never be copied even if the gateway returned them; a
 *     row with no `db_model` flag is "config" (the fail-safe: no Remove button), not "database".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGatewayCatalog, readGatewayCatalog } from '@core/models/gateway-catalog';

const cfg = (name: string, extra: Record<string, unknown> = {}) => ({ model_name: name, litellm_params: { model: 'openai/x' }, model_info: { id: `cfg-${name}`, db_model: false, ...extra } });
const db = (name: string, cred?: string, extra: Record<string, unknown> = {}) => ({
  model_name: name,
  litellm_params: { model: 'mistral/mistral-small', ...(cred ? { litellm_credential_name: cred } : {}) },
  model_info: { id: `db-${name}`, db_model: true, ...extra },
});

test('one row per alias; config-managed, database-managed and mixed are told apart', () => {
  const c = mapGatewayCatalog([cfg('sovereign-default'), db('acme-chat', 'acme'), cfg('both'), db('both')], []);
  const by = Object.fromEntries(c.models.map((m) => [m.name, m]));
  assert.deepEqual(c.models.map((m) => m.name).sort(), ['acme-chat', 'both', 'sovereign-default']);
  assert.equal(by['sovereign-default'].management, 'config');
  assert.equal(by['acme-chat'].management, 'database');
  assert.equal(by['both'].management, 'mixed');
  assert.equal(by['both'].deployments, 2);
});

test('NEGATIVE TWIN: a row with no db_model flag is config-managed (fail-safe: never offered for removal)', () => {
  const c = mapGatewayCatalog([{ model_name: 'x', litellm_params: { model: 'openai/y' } }], []);
  assert.equal(c.models[0].management, 'config');
});

test('embedding mode is reported; anything else is chat', () => {
  const c = mapGatewayCatalog([db('emb', undefined, { mode: 'embedding' }), db('chat', undefined, { mode: 'chat' }), db('none')], []);
  const mode = Object.fromEntries(c.models.map((m) => [m.name, m.mode]));
  assert.deepEqual(mode, { emb: 'embedding', chat: 'chat', none: 'chat' });
});

test('the connection of each model comes from LiteLLM\'s credentials; the credential list shows which models use it', () => {
  const c = mapGatewayCatalog([db('a', 'acme'), db('b', 'acme'), cfg('c')], [{ credential_name: 'acme', credential_info: { custom_llm_provider: 'mistral' } }, { credential_name: 'idle', credential_info: {} }]);
  assert.deepEqual(c.models.find((m) => m.name === 'a')!.credentials, ['acme']);
  assert.deepEqual(c.credentials!.map((x) => [x.name, x.models]), [['acme', ['a', 'b']], ['idle', []]]);
});

test('NEGATIVE TWIN: credential values are never copied, even if the gateway sent them', () => {
  const c = mapGatewayCatalog([db('a', 'acme')], [{ credential_name: 'acme', credential_info: { custom_llm_provider: 'mistral' }, credential_values: { api_key: 'sk-super-secret-value' } } as never]);
  assert.ok(!JSON.stringify(c).includes('sk-super-secret-value'));
  assert.ok(!JSON.stringify(c).includes('credential_values'));
});

test('readGatewayCatalog: the gateway\'s own answer; unreachable is a failure with the reason, never a list', async () => {
  const ok = await readGatewayCatalog({ models: async () => ({ ok: true, data: [db('only-in-litellm')] }), credentials: async () => ({ ok: true, data: [] }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.data.models.map((m) => m.name), ['only-in-litellm']);
  const down = await readGatewayCatalog({ models: async () => ({ ok: false, error: 'timeout after 2500ms' }), credentials: async () => ({ ok: true, data: [] }) });
  assert.deepEqual(down, { ok: false, error: 'timeout after 2500ms' });
});

test('credentials that cannot be listed do not hide the models, and say so', async () => {
  const r = await readGatewayCatalog({ models: async () => ({ ok: true, data: [db('a', 'acme')] }), credentials: async () => ({ ok: false, error: 'HTTP 500' }) });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.data.credentials, null);
    assert.equal(r.data.credentialsError, 'HTTP 500');
    assert.equal(r.data.models.length, 1);
  }
});
