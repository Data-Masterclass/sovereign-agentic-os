/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The model picker and Platform → Models & Providers read LiteLLM live and keep no model
 *             list, enable switch or seed of their own.
 * USER STORY: As a platform admin I add a model in LiteLLM and it is in the OS picker with no change
 *             in the OS; I remove it and it is gone. If LiteLLM cannot be reached the OS says it does
 *             not know — it does not show an old list.
 * ARCHITECTURE:
 *   - Auth and the LiteLLM reads are mocked; the routes and the catalog mapping are real. The real
 *     gateway is proven in `gateway-models.e2e.test.ts` (scripts/tests/gateway-models/run.sh).
 *   - NEGATIVE TWINS: the seed aliases never appear unless LiteLLM lists them; a removed model does
 *     not linger; the old enable/cap switches are refused, not silently ignored.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let LIVE: { ok: true; data: unknown[] } | { ok: false; error: string } = { ok: false, error: 'connect ECONNREFUSED' };
let CREDS: { ok: true; data: unknown[] } | { ok: false; error: string } = { ok: true, data: [] };
const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
mock.module('@core/kernel/auth', { namedExports: { requireUser: async () => ({ id: 'u1', name: 'Admin', domains: [], role: 'admin' }) } });
mock.module('@core/infra/litellm-admin', {
  namedExports: { ...(await real('@core/infra/litellm-admin')), readModels: async () => LIVE, readCredentials: async () => CREDS, readRouterAliases: async () => ({ ok: true, data: {} }) },
});
mock.module('../../../app/api/platform-admin/_ctx.ts', {
  namedExports: {
    adminCtx: async () => ({ user: { id: 'admin1', role: 'admin' }, tenant: { id: 't1' }, opa: 'opa-allow' }),
    fail: (e: Error) => Response.json({ error: e.message }, { status: (e as { status?: number }).status ?? 500 }),
  },
});

const agentsModels = await import('../../../app/api/agents/models/route.ts');
const adminModels = await import('../../../app/api/platform-admin/models/route.ts');
const adminModel = await import('../../../app/api/platform-admin/models/[id]/route.ts');
const models = await import('@tabs/admin/lib/models');

type Row = { model_name: string; management: string; credentials: string[]; mode?: string; task?: string };
type Body = { models: Row[]; source: string; error?: string; credentials: { name: string; models: string[] }[] | null };
const picker = async () => (await (await agentsModels.GET()).json()) as Body;
const dbRow = (name: string, cred?: string) => ({ model_name: name, litellm_params: { model: 'mistral/x', ...(cred ? { litellm_credential_name: cred } : {}) }, model_info: { id: `id-${name}`, db_model: true } });
const cfgRow = (name: string) => ({ model_name: name, litellm_params: { model: 'openai/y' }, model_info: { id: `cfg-${name}`, db_model: false } });

afterEach(() => {
  LIVE = { ok: false, error: 'connect ECONNREFUSED' };
  CREDS = { ok: true, data: [] };
});

test('a model added in LiteLLM is in the picker with no OS change, and gone when LiteLLM drops it', async () => {
  LIVE = { ok: true, data: [cfgRow('sovereign-default')] };
  assert.deepEqual((await picker()).models.map((m) => m.model_name), ['sovereign-default']);
  LIVE = { ok: true, data: [cfgRow('sovereign-default'), dbRow('acme-chat', 'acme')] };
  CREDS = { ok: true, data: [{ credential_name: 'acme', credential_info: {} }] };
  const added = await picker();
  assert.deepEqual(added.models.map((m) => m.model_name).sort(), ['acme-chat', 'sovereign-default']);
  assert.equal(added.models.find((m) => m.model_name === 'acme-chat')!.management, 'database');
  assert.equal(added.models.find((m) => m.model_name === 'sovereign-default')!.management, 'config');
  assert.deepEqual(added.models.find((m) => m.model_name === 'acme-chat')!.credentials, ['acme']);
  assert.deepEqual(added.credentials, [{ name: 'acme', models: ['acme-chat'], info: {} }]);
  LIVE = { ok: true, data: [cfgRow('sovereign-default')] };
  assert.deepEqual((await picker()).models.map((m) => m.model_name), ['sovereign-default'], 'a removed model does not linger');
});

test('NEGATIVE TWIN: no seed — an unreachable gateway is "unavailable" with the reason and NO models', async () => {
  const b = await picker();
  assert.equal(b.source, 'unavailable');
  assert.match(String(b.error), /ECONNREFUSED/);
  assert.deepEqual(b.models, []);
});

test('NEGATIVE TWIN: a gateway that answers with no models is an empty list from LiteLLM, not the install catalog', async () => {
  LIVE = { ok: true, data: [] };
  const b = await picker();
  assert.equal(b.source, 'litellm');
  assert.deepEqual(b.models, []);
});

test('Platform → Models reads the same live list; the OS keeps no enable switch or per-model cap', async () => {
  LIVE = { ok: true, data: [cfgRow('sovereign-default')] };
  const res = await adminModels.GET();
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal('models' in body, false, 'the platform route no longer serves an OS-held model list');
  assert.ok(body.defaults && 'assistant' in body);
  assert.ok(!JSON.stringify(body).includes('capEUR'));
});

test('the old per-model switches are refused (410), not silently ignored', async () => {
  for (const body of [{ op: 'enable', enabled: false }, { op: 'cap', capEUR: 5 }]) {
    const res = await adminModel.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'sovereign-default' }) });
    assert.equal(res.status, 410);
    assert.match(((await res.json()) as { error: string }).error, /LiteLLM/);
  }
});

test('the assistant pin must name a chat model LiteLLM lists right now; an unreachable gateway refuses', async () => {
  LIVE = { ok: true, data: [dbRow('acme-chat')] };
  const ok = await adminModel.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ op: 'assistant' }) }), { params: Promise.resolve({ id: 'acme-chat' }) });
  assert.equal(ok.status, 200);
  assert.equal(models.getAssistantModelId(), 'acme-chat');
  const ghost = await adminModel.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ op: 'assistant' }) }), { params: Promise.resolve({ id: 'ghost' }) });
  assert.equal(ghost.status, 404);
  LIVE = { ok: false, error: 'timeout' };
  const down = await adminModel.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ op: 'assistant' }) }), { params: Promise.resolve({ id: 'acme-chat' }) });
  assert.equal(down.status, 502);
  models._reset();
});

test('the models module holds no catalog, seed or enable switch any more', () => {
  const exported = Object.keys(models);
  for (const gone of ['listModels', 'setEnabled', 'setCap', 'registerModel', 'registerAssistantModel', 'removeModel', 'enabledMap']) {
    assert.ok(!exported.includes(gone), `${gone} must not exist: the model list is LiteLLM's`);
  }
});
