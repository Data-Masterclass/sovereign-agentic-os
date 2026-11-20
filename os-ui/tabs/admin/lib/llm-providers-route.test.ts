/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — the provider flow's gates: admin only, egress first, key never echoed
 * USER STORY: As a platform admin, a provider host that is not on the egress allowlist is refused BEFORE
 *             anything is stored, and I am told the exact change to make; a non-admin cannot reach any
 *             step; and the key I type is never sent back to my browser.
 * ARCHITECTURE:
 *   - The routes are real. `adminCtx` is replaced by a stand-in that refuses a non-admin exactly as
 *     `requireAdmin` does (403 "Admin only"); the gateway IO (`litellm-write` / `litellm-admin`) records
 *     every call, so "nothing was written" is an assertion, not an assumption.
 *   - The real gateway hops are proven in llm-providers.e2e.test.ts.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let ROLE = 'admin';
type Call = { method: 'GET' | 'POST'; path: string; body?: unknown };
let CALLS: Call[] = [];
let POST_REPLY: (path: string, body: unknown) => { ok: true; data: unknown } | { ok: false; error: string } = () => ({ ok: true, data: {} });

mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => {
      if (ROLE !== 'admin') { const e = new Error('Admin only'); (e as Error & { status?: number }).status = 403; throw e; }
      return { user: { id: 'ada', role: 'admin', domains: [] }, tenant: { id: 't' }, opa: 'opa-allow' };
    },
    fail: (e: unknown) => {
      const status = (e as { status?: number })?.status ?? 500;
      return new Response(JSON.stringify({ error: (e as Error).message }), { status, headers: { 'content-type': 'application/json' } });
    },
  },
});
let OPA_ALLOWS = true;
mock.module('@core/infra/governed', {
  namedExports: { authorize: async () => (OPA_ALLOWS ? { allowed: true, policy: 'opa-allow' } : { allowed: false, policy: 'opa-deny' }) },
});
mock.module('@tabs/admin/lib/audit', { namedExports: { audit: () => undefined } });
mock.module('@/app/api/platform-admin/_compile', { namedExports: { recompile: async () => ({ publish: 'skipped' }) } });
mock.module('@core/infra/litellm-write', {
  namedExports: {
    adminPost: async (path: string, body: unknown) => { CALLS.push({ method: 'POST', path, body }); return POST_REPLY(path, body); },
  },
});
mock.module('@core/infra/litellm-admin', {
  namedExports: {
    adminGet: async (path: string) => { CALLS.push({ method: 'GET', path }); return { ok: true, data: path === '/credentials' ? { credentials: [] } : [] }; },
    readModels: async () => { CALLS.push({ method: 'GET', path: '/model/info' }); return { ok: true, data: [] }; },
  },
});

process.env.LLM_EGRESS_ALLOWLIST = 'api.mistral.ai,onstackit.cloud,azure-ok.example.test';

const connections = await import('../../../app/api/platform-admin/providers/connections/route.ts');
const testRoute = await import('../../../app/api/platform-admin/providers/test/route.ts');
const models = await import('../../../app/api/platform-admin/providers/models/route.ts');
const migration = await import('../../../app/api/platform-admin/providers/migration/route.ts');
const catalog = await import('../../../app/api/platform-admin/providers/route.ts');

const req = (body: unknown) => new Request('http://os/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const AZURE = { preset: 'azure', name: 'azure-prod', apiBase: 'https://azure-ok.example.test', apiVersion: '2024-10-21', apiKey: 'sk-secret-typed-by-admin' };

beforeEach(() => { OPA_ALLOWS = true; ROLE = 'admin'; CALLS = []; POST_REPLY = () => ({ ok: true, data: {} }); });

test('a non-admin is refused at every step, and the gateway is never called', async () => {
  ROLE = 'builder';
  const responses = [
    await catalog.GET(),
    await connections.POST(req(AZURE)),
    await testRoute.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'd1' })),
    await models.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'd1', alias: 'azure-gpt', mode: 'chat' })),
    await models.GET(new Request('http://os/x?preset=mistral')),
    await migration.GET(),
  ];
  for (const r of responses) assert.equal(r.status, 403);
  assert.deepEqual(CALLS, []);
});

test('an admin the policy (OPA) does not allow is refused before any gateway write', async () => {
  OPA_ALLOWS = false;
  for (const r of [
    await connections.POST(req(AZURE)),
    await testRoute.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'd1' })),
    await models.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'd1', alias: 'azure-gpt', mode: 'chat' })),
  ]) assert.equal(r.status, 403);
  assert.deepEqual(CALLS, []);
});

test('a host that is not on the egress allowlist is refused before anything is stored, with guidance', async () => {
  const res = await connections.POST(req({ ...AZURE, apiBase: 'https://acme.openai.azure.com' }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.code, 'egress_not_allowed');
  assert.equal(body.host, 'acme.openai.azure.com');
  assert.match(body.guidance, /llmProviders\.allowHosts/);
  assert.deepEqual(CALLS.filter((c) => c.method === 'POST'), []); // no credential, no model
});

test('a connection goes to LiteLLM\'s own credential store; the key is never sent back', async () => {
  const res = await connections.POST(req(AZURE));
  assert.equal(res.status, 201);
  const text = JSON.stringify(await res.json());
  assert.doesNotMatch(text, /sk-secret-typed-by-admin/);
  const post = CALLS.find((c) => c.method === 'POST');
  assert.equal(post?.path, '/credentials');
  assert.deepEqual(post?.body, {
    credential_name: 'azure-prod',
    credential_info: { custom_llm_provider: 'azure', os_preset: 'azure' },
    credential_values: { api_base: 'https://azure-ok.example.test', api_version: '2024-10-21', api_key: 'sk-secret-typed-by-admin' },
  });
});

test('a wrong key comes back as a clear sentence from LiteLLM\'s own connection test', async () => {
  POST_REPLY = (path) => path === '/health/test_connection'
    ? { ok: true, data: { status: 'error', result: { error: 'litellm.AuthenticationError: AzureException - Access denied due to invalid subscription key\nstack trace: Traceback …' } } }
    : { ok: true, data: {} };
  const res = await testRoute.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'os-gpt-deploy', mode: 'chat' }));
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.message, /rejected the API key/);
  assert.doesNotMatch(JSON.stringify(body), /Traceback/);
  assert.deepEqual(CALLS.find((c) => c.path === '/health/test_connection')?.body, {
    litellm_params: { model: 'azure/os-gpt-deploy', litellm_credential_name: 'azure-prod' }, mode: 'chat',
  });
});

test('a model is registered by credential name, into the access group the shared agent key holds', async () => {
  const res = await models.POST(req({ connection: 'azure-prod', preset: 'azure', model: 'os-gpt-deploy', alias: 'azure-gpt', mode: 'chat' }));
  assert.equal(res.status, 201);
  const post = CALLS.find((c) => c.path === '/model/new');
  assert.deepEqual(post?.body, {
    model_name: 'azure-gpt',
    litellm_params: { model: 'azure/os-gpt-deploy', litellm_credential_name: 'azure-prod' },
    model_info: { mode: 'chat', access_groups: ['os-admin-models'], os_preset: 'azure' },
  });
});

test('every provider route is gated by adminCtx() before anything else', () => {
  const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const p of ['', '/connections', '/test', '/models', '/migration']) {
    const src = readFileSync(resolve(OSUI, `app/api/platform-admin/providers${p}/route.ts`), 'utf8');
    assert.match(src, /await adminCtx\(\)/, `providers${p} must call adminCtx()`);
  }
});
