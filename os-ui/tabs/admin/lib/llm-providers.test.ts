/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Provider-agnostic LLM setup — the pure rules (presets, model strings, egress, errors, migration)
 * USER STORY: As a platform admin installing the OS on Azure, on my own servers or on STACKIT, I connect
 *             my LLM endpoint the way LiteLLM itself documents it, and STACKIT is one preset, not the rule.
 * ARCHITECTURE:
 *   - These are the decisions the flow makes BEFORE it calls LiteLLM: which LiteLLM provider and
 *     `litellm_params` a preset produces, whether the host may leave through the egress proxy, and how a
 *     LiteLLM error reads to an admin. The calls themselves are proven against the real gateway in
 *     llm-providers.e2e.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, presetById, modelString, credentialValues, providerEgress, explainGatewayError,
  planProviderMigration, validCredentialName,
} from '@tabs/admin/lib/llm-providers';

test('STACKIT is one preset among Azure, OpenAI-compatible, Ollama and Mistral — and any LiteLLM provider', () => {
  const ids = PRESETS.map((p) => p.id);
  for (const id of ['azure', 'openai-compatible', 'ollama', 'mistral', 'stackit', 'litellm']) assert.ok(ids.includes(id), id);
  // Every preset names a REAL LiteLLM provider id (or, for "any provider", lets the admin pick one).
  assert.equal(presetById('azure')?.litellmProvider, 'azure');
  assert.equal(presetById('ollama')?.litellmProvider, 'ollama_chat');
  assert.equal(presetById('mistral')?.litellmProvider, 'mistral');
  assert.equal(presetById('openai-compatible')?.litellmProvider, 'openai');
  assert.equal(presetById('stackit')?.litellmProvider, 'openai');
  assert.equal(presetById('litellm')?.litellmProvider, null);
});

test('model strings use LiteLLM\'s native provider prefix, never a forced openai/', () => {
  assert.equal(modelString('azure', 'os-gpt-deploy'), 'azure/os-gpt-deploy');
  assert.equal(modelString('ollama_chat', 'llama3.2:1b'), 'ollama_chat/llama3.2:1b');
  assert.equal(modelString('mistral', 'mistral-small-latest'), 'mistral/mistral-small-latest');
  // An admin who already typed the prefix is not double-prefixed …
  assert.equal(modelString('mistral', 'mistral/mistral-small-latest'), 'mistral/mistral-small-latest');
  // … but STACKIT's org prefix is part of the model id and is kept under openai/.
  assert.equal(modelString('openai', 'Qwen/Qwen3-VL-235B-A22B-Instruct-FP8'), 'openai/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8');
  // EU Router ids contain a slash; under the OpenAI-compatible route they go upstream unchanged.
  assert.equal(modelString('openai', 'azure/gpt-5.1'), 'openai/azure/gpt-5.1');
  assert.throws(() => modelString('azure', '  '), /model/i);
});

test('credential values follow the fields LiteLLM asks for (Azure needs api_version; Ollama has no key)', () => {
  assert.deepEqual(
    credentialValues(presetById('azure')!, { apiBase: 'https://acme.openai.azure.com', apiVersion: '2024-10-21', apiKey: 'k' }),
    { api_base: 'https://acme.openai.azure.com', api_version: '2024-10-21', api_key: 'k' },
  );
  assert.throws(() => credentialValues(presetById('azure')!, { apiBase: 'https://acme.openai.azure.com', apiKey: 'k' }), /api_version|API version/i);
  assert.throws(() => credentialValues(presetById('azure')!, { apiBase: 'https://acme.openai.azure.com', apiVersion: '2024-10-21' }), /key/i);
  assert.deepEqual(credentialValues(presetById('ollama')!, { apiBase: 'http://ollama:11434' }), { api_base: 'http://ollama:11434' });
  // STACKIT pre-fills its documented endpoint; nothing else about it is special.
  assert.deepEqual(credentialValues(presetById('stackit')!, { apiKey: 'k' }), {
    api_base: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', api_key: 'k',
  });
  // Mistral's own endpoint is LiteLLM's default; the host is still known for the egress check.
  assert.deepEqual(credentialValues(presetById('mistral')!, { apiKey: 'k' }), { api_key: 'k' });
});

test('egress: an external host must be on the proxy allowlist, with the exact change to make', () => {
  const allow = ['api.mistral.ai', 'onstackit.cloud'];
  assert.deepEqual(providerEgress(presetById('mistral')!, undefined, allow), { ok: true, host: 'api.mistral.ai', route: 'egress-proxy' });
  assert.equal(providerEgress(presetById('stackit')!, 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', allow).ok, true);
  const blocked = providerEgress(presetById('azure')!, 'https://acme.openai.azure.com', allow);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.host, 'acme.openai.azure.com');
  assert.match(blocked.guidance ?? '', /llmProviders\.allowHosts/);
  assert.match(blocked.guidance ?? '', /acme\.openai\.azure\.com/);
  // In-cluster names are reached directly (on the gateway's NO_PROXY), never through the internet proxy.
  assert.deepEqual(providerEgress(presetById('ollama')!, 'http://ollama:11434', allow, ['ollama']), { ok: true, host: 'ollama', route: 'in-cluster' });
  assert.equal(providerEgress(presetById('ollama')!, 'http://ollama.models.svc.cluster.local:11434', allow, []).route, 'in-cluster');
  // A bare name the gateway would still send to the proxy is refused, with the two ways to fix it.
  const bare = providerEgress(presetById('ollama')!, 'http://ollama:11434', allow, []);
  assert.equal(bare.ok, false);
  assert.match(bare.guidance ?? '', /llmProviders\.noProxy/);
  // Metadata / loopback / private addresses are refused outright.
  assert.equal(providerEgress(presetById('openai-compatible')!, 'http://169.254.169.254/v1', allow).ok, false);
  assert.equal(providerEgress(presetById('openai-compatible')!, 'http://192.168.1.20:8000/v1', allow).ok, false);
  // An unknown host (any-provider preset without a base URL) is not waved through.
  assert.equal(providerEgress(presetById('litellm')!, undefined, allow).ok, false);
});

test('LiteLLM errors read as a clear sentence: wrong key, blocked host, unknown deployment', () => {
  assert.match(explainGatewayError('litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided.'), /rejected the API key/);
  assert.match(explainGatewayError('litellm.AuthenticationError: AzureException - Access denied due to invalid subscription key'), /rejected the API key/);
  assert.match(explainGatewayError('litellm.PermissionDeniedError: OpenAIException - <html>Filtered</html> 403 Forbidden by tinyproxy'), /egress/i);
  assert.match(explainGatewayError('litellm.InternalServerError: OpenAIException - Connection error.'), /could not reach/i);
  assert.match(explainGatewayError('litellm.NotFoundError: AzureException - DeploymentNotFound'), /not found/i);
  // Stack traces never reach the admin.
  assert.doesNotMatch(explainGatewayError('litellm.APIError: boom\nstack trace: Traceback (most recent call last): File x'), /Traceback/);
});

test('credential names are LiteLLM-safe slugs', () => {
  assert.equal(validCredentialName('azure-prod'), true);
  assert.equal(validCredentialName('Azure Prod!'), false);
  assert.equal(validCredentialName(''), false);
});

test('migration dry run: lists every model, its host and route, and what /model/update would add — writes nothing', () => {
  const plan = planProviderMigration([
    { model_name: 'sovereign-default', litellm_params: { model: 'openai/gpt-oss-20b', api_base: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1' }, model_info: { id: 'seed-1', db_model: false } },
    { model_name: 'mistral-small', litellm_params: { model: 'openai/mistral-small-latest', api_base: 'https://api.mistral.ai/v1' }, model_info: { id: 'db-1', db_model: true } },
    { model_name: 'azure-gpt', litellm_params: { model: 'azure/os-gpt-deploy', api_base: 'https://acme.openai.azure.com' }, model_info: { id: 'db-2', db_model: true, access_groups: ['os-admin-registered'] } },
    { model_name: 'local-llama', litellm_params: { model: 'ollama_chat/llama3', api_base: 'http://ollama:11434' }, model_info: { id: 'db-3', db_model: true } },
  ], ['onstackit.cloud'], 'os-admin-registered', ['ollama']);
  const by = Object.fromEntries(plan.rows.map((r) => [r.model, r]));
  assert.equal(by['sovereign-default'].egress, 'allowed');
  assert.equal(by['sovereign-default'].update, null); // seeded: chart-owned, never rewritten
  assert.equal(by['mistral-small'].egress, 'blocked');
  assert.deepEqual(by['mistral-small'].update, { endpoint: '/model/update', payload: { model_info: { id: 'db-1', access_groups: ['os-admin-registered'] } } });
  assert.equal(by['azure-gpt'].update, null); // already in the group
  assert.equal(by['local-llama'].egress, 'in-cluster');
  assert.deepEqual(plan.blockedHosts, ['acme.openai.azure.com', 'api.mistral.ai']);
  assert.equal(plan.dryRun, true);
});
