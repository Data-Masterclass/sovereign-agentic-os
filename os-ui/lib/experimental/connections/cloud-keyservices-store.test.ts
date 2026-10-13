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

const KEY_SERVICE_KEYS = ['entra', 'purview', 'ai-foundry', 'sagemaker', 'gcp-identity', 'gcp-directory', 'snowflake-governance'] as const;

test('templates: all key-service connectors registered, user-facing, guided', () => {
  for (const key of KEY_SERVICE_KEYS) {
    assert.ok(CONNECTION_TEMPLATES.some((t) => t.key === key), `${key} template row exists`);
    assert.ok((USER_FACING_TEMPLATE_KEYS as string[]).includes(key), `${key} is user-facing`);
    assert.ok(installGuideFor(key), `${key} has an install guide`);
  }
});

test('all key-service connectors are READ-ONLY: the preset ships no write tool at all', () => {
  for (const key of KEY_SERVICE_KEYS) {
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

test('Google Cloud: a READ auto-allows, exchanges a JWT for a bearer, reaches Resource Manager', async () => {
  __resetConnections();
  // A throwaway SA JSON with a real (test-generated) RSA key so the JWT can be signed.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saJson = JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  const c = await createConnection(builder, { name: 'gcp', template: 'gcp-identity', endpoint: 'https://cloudresourcemanager.googleapis.com/v1', credential: saJson });
  const calls = scriptFetch((url) => {
    if (url.includes('oauth2.googleapis.com/token')) return { status: 200, body: { access_token: 'ya29.fake' } };
    return { status: 200, body: { projects: [{ projectId: 'p1', name: 'One', projectNumber: '9', lifecycleState: 'ACTIVE' }] } };
  });
  const r = await callConnectionTool(c.id, builder, { tool: 'list_projects' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { projects?: { projectId: string }[] };
  assert.ok(result.projects && result.projects[0].projectId === 'p1', 'real client shape, not the mock');
  assert.ok(calls.some((x) => x.url.includes('oauth2.googleapis.com/token')), 'did a token exchange');
  assert.ok(calls.some((x) => x.url.includes('cloudresourcemanager.googleapis.com')), 'hit Resource Manager');
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'), 'SA private key never in the tool result');
  offline();
});

test('Google Workspace directory: a READ auto-allows, delegates via a `sub`-claim JWT, reaches the Admin SDK', async () => {
  __resetConnections();
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Extended SA JSON: the key plus the non-secret delegation routing (subject + customer).
  const saJson = JSON.stringify({
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    subject: 'admin@acme.example',
    customer: 'my_customer',
  });
  const c = await createConnection(builder, { name: 'gws', template: 'gcp-directory', endpoint: 'https://admin.googleapis.com/admin/directory/v1', credential: saJson });
  const calls = scriptFetch((url, init) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      // Prove the assertion carries the domain-wide-delegation `sub` claim.
      const assertion = String(init.body ?? '').split('assertion=')[1] ?? '';
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString());
      assert.equal(claims.sub, 'admin@acme.example', 'JWT sub = impersonated admin');
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/admin.directory.readonly');
      return { status: 200, body: { access_token: 'ya29.fake' } };
    }
    return { status: 200, body: { users: [{ id: 'u1', primaryEmail: 'ada@acme.example', name: { fullName: 'Ada' }, isAdmin: false, suspended: false, orgUnitPath: '/' }] } };
  });
  const r = await callConnectionTool(c.id, builder, { tool: 'list_users' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { users?: { primaryEmail: string }[] };
  assert.ok(result.users && result.users[0].primaryEmail === 'ada@acme.example', 'real client shape, not the mock');
  assert.ok(calls.some((x) => x.url.includes('oauth2.googleapis.com/token')), 'did a token exchange');
  assert.ok(calls.some((x) => x.url.includes('admin.googleapis.com/admin/directory/v1/users')), 'hit the Admin SDK');
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'), 'SA private key never in the tool result');
  offline();
});

test('Snowflake governance: a READ auto-allows, key-pair-JWTs, reaches the SQL REST API', async () => {
  __resetConnections();
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const c = await createConnection(builder, { name: 'sfgov', template: 'snowflake-governance', endpoint: 'https://org-acct.snowflakecomputing.com', credential: `ORG-ACCT:gov_reader:${pem}` });
  const calls = scriptFetch((url, init) => {
    assert.ok(url.includes('org-acct.snowflakecomputing.com/api/v2/statements'));
    const h = init.headers as Record<string, string>;
    assert.equal(h['x-snowflake-authorization-token-type'], 'KEYPAIR_JWT');
    return { status: 200, body: { resultSetMetaData: { rowType: [{ name: 'NAME' }] }, data: [['ADA']] } };
  });
  const r = await callConnectionTool(c.id, builder, { tool: 'list_users' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { users?: Record<string, unknown>[] };
  assert.ok(result.users && result.users[0].NAME === 'ADA');
  assert.ok(calls.length > 0);
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'), 'RSA key never in the tool result');
  offline();
});

test('restore the real fetch', () => {
  globalThis.fetch = _realFetch;
});
