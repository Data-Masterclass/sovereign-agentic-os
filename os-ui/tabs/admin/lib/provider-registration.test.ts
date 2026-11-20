/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the LiteLLM `/model/new` body of an admin-registered provider model.
 * USER STORY: As a platform admin, a provider I register is callable by the shared agent key,
 *             can use LiteLLM's native provider, and is priced so budgets bind.
 * ARCHITECTURE: Pure builder (tabs/admin/lib/provider-registration.ts); no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_REGISTERED_ACCESS_GROUP, buildProviderModel, litellmModelFor, normaliseProvider } from '@tabs/admin/lib/provider-registration';

const KEY = 'sk-fake-test-0000';

test('OpenAI-compatible (Mistral by URL): openai/ prefix, api_base kept, joins the admin access group', () => {
  const p = buildProviderModel({ alias: 'mistral-small', modelName: 'mistral-small-latest', baseUrl: 'https://api.mistral.ai/v1', apiKey: KEY, mode: 'chat' });
  assert.deepEqual(p, {
    model_name: 'mistral-small',
    litellm_params: { model: 'openai/mistral-small-latest', api_key: KEY, api_base: 'https://api.mistral.ai/v1' },
    model_info: { mode: 'chat', access_groups: [ADMIN_REGISTERED_ACCESS_GROUP] },
  });
});

test('the access group is the name the chart lists on the shared agent key', async () => {
  const { readFileSync } = await import('node:fs');
  const values = readFileSync(new URL('../../../../charts/sovereign-agentic-os/values.yaml', import.meta.url), 'utf8');
  const block = values.slice(values.indexOf('\nlitellmAgentKey:'), values.indexOf('modelMaxBudget', values.indexOf('\nlitellmAgentKey:')));
  assert.match(block, new RegExp(`^\\s*- ${ADMIN_REGISTERED_ACCESS_GROUP}\\b`, 'm'));
});

test('EUrouter ids that contain a slash go upstream unchanged after openai/', () => {
  assert.equal(litellmModelFor('azure/gpt-5.1', ''), 'openai/azure/gpt-5.1');
  assert.equal(litellmModelFor('mistral-large-3', ''), 'openai/mistral-large-3');
  assert.equal(litellmModelFor('openai/gpt-x', ''), 'openai/gpt-x');
});

test('native LiteLLM provider: mistral/ prefix, base URL optional and omitted when blank', () => {
  const p = buildProviderModel({ alias: 'mistral-native', modelName: 'mistral-small-latest', apiKey: KEY, mode: 'chat', litellmProvider: 'Mistral' });
  assert.equal(p.litellm_params.model, 'mistral/mistral-small-latest');
  assert.equal('api_base' in p.litellm_params, false);
});

test('a typed provider prefix is not doubled', () => {
  assert.equal(litellmModelFor('mistral/mistral-small-latest', 'mistral'), 'mistral/mistral-small-latest');
});

test('openai / openai-compatible / blank all mean the OpenAI-compatible route', () => {
  for (const v of ['', 'openai', 'OpenAI', 'openai-compatible', undefined]) assert.equal(normaliseProvider(v), '');
  assert.equal(normaliseProvider('together_ai'), 'together_ai');
  assert.throws(() => normaliseProvider('mistral/x'), /not a LiteLLM provider name/);
});

test('prices per 1M tokens become LiteLLM per-token costs', () => {
  const p = buildProviderModel({ alias: 'm', modelName: 'x', baseUrl: 'https://h/v1', apiKey: KEY, mode: 'chat', inputPerM: 0.1, outputPerM: 0.3 });
  assert.ok(Math.abs((p.litellm_params.input_cost_per_token ?? 0) - 1e-7) < 1e-15);
  assert.ok(Math.abs((p.litellm_params.output_cost_per_token ?? 0) - 3e-7) < 1e-15);
});

test('incomplete or malformed input is refused with status 400', () => {
  const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { status?: number }).status; } return 0; };
  assert.equal(err(() => buildProviderModel({ alias: 'm', modelName: 'x', apiKey: KEY, mode: 'chat' })), 400); // no base URL, no native provider
  assert.equal(err(() => buildProviderModel({ alias: '', modelName: 'x', baseUrl: 'https://h', apiKey: KEY, mode: 'chat' })), 400);
  assert.equal(err(() => buildProviderModel({ alias: 'm', modelName: 'x', baseUrl: 'https://h', apiKey: '', mode: 'chat' })), 400);
  assert.equal(err(() => buildProviderModel({ alias: 'm', modelName: 'x', baseUrl: 'https://h', apiKey: KEY, mode: 'chat', inputPerM: -1 })), 400);
});
