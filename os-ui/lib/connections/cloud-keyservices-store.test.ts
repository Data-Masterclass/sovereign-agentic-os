/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Store-level DoD coverage for the cloud key-services wave (Entra / Purview /
 * AI-Foundry / SageMaker): the non-negotiables through the governed
 * `callConnectionTool` path — write-only secret, unseeable id → not_found, reads
 * auto-allow and reach the REAL client (mocked via a scripted global fetch) instead
 * of the offline mock — plus that these are READ-ONLY connectors (no write tool in
 * the preset, so nothing can be auto-run or held).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the store so getCache() initialises an empty offline Map.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  createConnection,
  callConnectionTool,
  getConnectionForUser,
  __resetConnections,
} = await import('./store.ts');
const { hasSecret, getSecretServerSide } = await import('@/lib/infra/secrets');
const { CONNECTION_TEMPLATES, USER_FACING_TEMPLATE_KEYS } = await import('./schema.ts');
const { installGuideFor } = await import('./install-guides.ts');

const builder = { id: 'b1', name: 'B', domains: ['eng'], role: 'builder' as const };
const stranger = { id: 's1', name: 'S', domains: ['other'], role: 'builder' as const };

function scriptFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = handler(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
  return calls;
}
function offline() { globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch; }

test('templates: entra / purview / ai-foundry / sagemaker registered, user-facing, guided', () => {
  for (const key of ['entra', 'purview', 'ai-foundry', 'sagemaker'] as const) {
    assert.ok(CONNECTION_TEMPLATES.some((t) => t.key === key), `${key} template row exists`);
    assert.ok((USER_FACING_TEMPLATE_KEYS as string[]).includes(key), `${key} is user-facing`);
    assert.ok(installGuideFor(key), `${key} has an install guide`);
  }
});

test('all four are READ-ONLY: the preset ships no write tool at all', () => {
  for (const key of ['entra', 'purview', 'ai-foundry', 'sagemaker'] as const) {
    const tpl = CONNECTION_TEMPLATES.find((t) => t.key === key)!;
    assert.ok(tpl.tools.length > 0, `${key} has tools`);
    assert.ok(tpl.tools.every((t) => t.write === false && t.mode === 'Read'), `${key} exposes only reads`);
  }
});

test('secret is WRITE-ONLY: the credential is vaulted, never on the serialized record', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'entra', template: 'entra', endpoint: 'https://graph.microsoft.com/v1.0', credential: 'eyJ_super_secret_token_xxx' });
  assert.ok(hasSecret(c.secretRef));
  assert.equal(getSecretServerSide(c.secretRef), 'eyJ_super_secret_token_xxx');
  assert.ok(!JSON.stringify(c).includes('eyJ_super_secret_token_xxx'), 'secret absent from the record');
  assert.ok(c.secretFingerprint.startsWith('sha256:'));
});

test('SageMaker AWS keys are vaulted as a pair and never on the record', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'sm', template: 'sagemaker', endpoint: 'https://api.sagemaker.eu-central-1.amazonaws.com', credential: 'AKIA_fake:top-secret-aws-key-xyz' });
  assert.equal(getSecretServerSide(c.secretRef), 'AKIA_fake:top-secret-aws-key-xyz');
  assert.ok(!JSON.stringify(c).includes('top-secret-aws-key-xyz'), 'AWS secret key absent from the record');
});

test('unseeable id → not_found (no existence leak)', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'p', template: 'purview', endpoint: 'https://acme.purview.azure.com', credential: 'tok' });
  assert.equal((await getConnectionForUser(c.id, builder)).id, c.id);
  await assert.rejects(() => getConnectionForUser(c.id, stranger), /not found/i);
});

test('Entra: a READ auto-allows and the executor reaches the REAL Graph API (not the mock)', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'entra', template: 'entra', endpoint: 'https://graph.microsoft.com/v1.0', credential: 'eyJ_x' });
  const calls = scriptFetch(() => ({ status: 200, body: { value: [{ id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@x.com', mail: 'ada@x.com' }] } }));
  const r = await callConnectionTool(c.id, builder, { tool: 'list_users' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { users?: { displayName: string }[] };
  assert.ok(result.users && result.users[0].displayName === 'Ada', 'real client shape, not the mock');
  assert.ok(calls.some((x) => x.url.includes('graph.microsoft.com') && x.url.includes('/users')), 'hit the real Graph API');
  assert.ok(!JSON.stringify(r).includes('eyJ_x'), 'token never in the tool result');
  offline();
});

test('Purview: a READ auto-allows and reaches the real Atlas search API', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'p', template: 'purview', endpoint: 'https://acme.purview.azure.com', credential: 'tok' });
  const calls = scriptFetch(() => ({ status: 200, body: { value: [{ guid: 'a1', name: 'orders', entityType: 'table', qualifiedName: 'q' }] } }));
  const r = await callConnectionTool(c.id, builder, { tool: 'search_assets', args: { keywords: 'orders' } });
  assert.equal(r.decision, 'allow');
  assert.ok(calls.some((x) => x.url.includes('acme.purview.azure.com/catalog/api/search/query')));
  offline();
});

test('AI Foundry: a READ auto-allows and reaches the real Azure ML model registry', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'af', template: 'ai-foundry', endpoint: 'https://eastus.api.azureml.ms', credential: 'tok' });
  const calls = scriptFetch(() => ({ status: 200, body: { value: [{ name: 'm1', version: '1', id: 'id1' }] } }));
  const r = await callConnectionTool(c.id, builder, { tool: 'list_models' });
  assert.equal(r.decision, 'allow');
  assert.ok(calls.some((x) => x.url.includes('eastus.api.azureml.ms/modelregistry')));
  offline();
});

test('SageMaker: a READ auto-allows, signs with SigV4, reaches the real endpoint', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'sm', template: 'sagemaker', endpoint: 'https://api.sagemaker.eu-central-1.amazonaws.com', credential: 'AKIA_x:secret_y' });
  const calls = scriptFetch((_url, init) => {
    const h = init.headers as Record<string, string>;
    assert.ok(h.authorization?.startsWith('AWS4-HMAC-SHA256 '), 'SigV4 Authorization present');
    assert.equal(h['x-amz-target'], 'SageMaker.ListModels');
    return { status: 200, body: { Models: [{ ModelName: 'm1', ModelArn: 'arn:m1' }] } };
  });
  const r = await callConnectionTool(c.id, builder, { tool: 'list_models' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { models?: { name: string }[] };
  assert.ok(result.models && result.models[0].name === 'm1');
  assert.ok(calls.some((x) => x.url.includes('api.sagemaker.eu-central-1.amazonaws.com')));
  assert.ok(!JSON.stringify(r).includes('secret_y'), 'AWS secret never in the tool result');
  offline();
});

test('an unknown tool on a read-only connector degrades honestly (never throws)', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'entra', template: 'entra', endpoint: 'https://graph.microsoft.com/v1.0', credential: 'eyJ_x' });
  const r = await callConnectionTool(c.id, builder, { tool: 'list_users' }).catch(() => null);
  // list_users is a valid read; a bogus tool name is denied by the gate (not exposed),
  // proving no unexposed capability slips through.
  const bogus = await callConnectionTool(c.id, builder, { tool: 'delete_everything' });
  assert.notEqual(bogus.decision, 'allow');
  assert.ok(r);
  offline();
});

test('restore the real fetch', () => {
  globalThis.fetch = _realFetch;
});
