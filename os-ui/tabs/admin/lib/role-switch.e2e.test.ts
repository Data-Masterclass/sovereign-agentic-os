/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The switch to the three role names, proven on the REAL LiteLLM image.
 * USER STORY: As the owner I remap `sovereign-strong` from one catalog model to another and the very next
 *             call of an agent system (its own virtual key, which allows the three role names) and of the
 *             shared key answers from the new model — no restart, no key rebuild — and the spend is
 *             booked per role and per model.
 * ARCHITECTURE:
 *   - Same containers as model-roles.e2e.test.ts (scripts/tests/gateway-models/run.sh). Catalog models are
 *     DB models with `mock_response` and a real per-token price, so a call answers "from-<name>" and costs
 *     something. The OS side is production code: `keyWanted` (the key an agent system gets), `applyRoleMapping`
 *     over `liveRoleIo`, `seedRoleMapping`. The key is created and read with LiteLLM's own `/key/*` API.
 *   - Negative twins: a key WITHOUT the role names is refused (so the allowlist is what makes a remap
 *     work); a mapping to a model outside the catalog changes nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const MASTER = process.env.LITELLM_MASTER_KEY ?? '';
const REQUIRED = process.env.GATEWAY_MODELS_E2E_REQUIRED === '1';
if (REQUIRED && (!GW || !MASTER)) throw new Error('GATEWAY_MODELS_E2E_REQUIRED=1 but LITELLM_URL / LITELLM_MASTER_KEY are not set');
const skip = GW && MASTER && REQUIRED ? false : 'run scripts/tests/gateway-models/run.sh (needs the real LiteLLM image)';

const reposDir = mkdtempSync(join(tmpdir(), 'os-role-switch-e2e-'));
const { liveRoleIo } = await import('@core/models/role-live');
const { applyRoleMapping, reconcileRoleMapping } = await import('@core/models/role-reconcile');
const { seedRoleMapping } = await import('@core/models/role-seed');
const { ROLE_NAMES, ModelMappingError } = await import('@core/models/role-mapping');
const { keyWanted } = await import('@tabs/agents/lib/build/live');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { compile } = await import('@tabs/agents/lib/langgraph-compile');
const io = () => liveRoleIo({ reposDir });

const admin = (path: string, body?: unknown, method = 'POST') =>
  fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const chat = async (key: string, model: string) => {
  const res = await fetch(`${GW}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string; type?: string; code?: string } };
  return { status: res.status, content: body.choices?.[0]?.message?.content, error: body.error };
};
const sfx = randomBytes(3).toString('hex');
const A = `sw-a-${sfx}`, B = `sw-b-${sfx}`, W = `sw-w-${sfx}`, E = `sw-e-${sfx}`;
const modelIds: string[] = [];
const keys: string[] = [];
async function addModel(name: string, mode: 'chat' | 'embedding' = 'chat') {
  const r = await admin('/model/new', { model_name: name, litellm_params: { model: 'openai/stub', api_key: 'unused', mock_response: `from-${name}`, input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 }, model_info: { mode } });
  assert.equal(r.status, 200, await r.text());
  const info = (await (await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } })).json()) as { data: { model_name: string; model_info: { id: string } }[] };
  modelIds.push(info.data.find((m) => m.model_name === name)!.model_info.id);
}
async function newKey(models: string[], alias: string) {
  const r = await admin('/key/generate', { models, key_alias: `${alias}-${sfx}`, max_budget: 5, budget_duration: '7d' });
  assert.equal(r.status, 200, await r.text());
  const k = (await r.json()) as { key: string; token?: string };
  keys.push(k.key);
  return k.key;
}
const keyInfo = async (key: string) => ((await (await admin(`/key/info?key=${encodeURIComponent(key)}`, undefined, 'GET')).json()) as { info: { models: string[]; spend: number; token: string } }).info;

after(async () => {
  if (skip) { rmSync(reposDir, { recursive: true, force: true }); return; }
  for (const k of keys) await admin('/key/delete', { keys: [k] });
  for (const id of modelIds) await admin('/model/delete', { id });
  await admin('/config/update', { router_settings: { model_group_alias: {} } });
  rmSync(reposDir, { recursive: true, force: true });
});

test('REAL GATEWAY: the first mapping is seeded into os/models.yml once (a second run is a no-op)', { skip }, async () => {
  for (const n of [A, B, W]) await addModel(n);
  await addModel(E, 'embedding');
  const seed = { 'sovereign-strong': A, 'sovereign-worker': W, 'sovereign-embedding': E };
  const first = await seedRoleMapping({ readMapping: io().readMapping, writeMapping: io().writeMapping, catalog: io().catalog }, { seed, legacy: null }, { by: 'system:os-ui' });
  assert.equal(first.state, 'seeded', JSON.stringify(first));
  const second = await seedRoleMapping({ readMapping: io().readMapping, writeMapping: io().writeMapping, catalog: io().catalog }, { seed, legacy: null }, { by: 'system:os-ui' });
  assert.equal(second.state, 'already-mapped');
  const rep = await reconcileRoleMapping(io());
  assert.ok(rep.ok && rep.state !== 'unmapped', JSON.stringify(rep));
});

test('REAL GATEWAY: an agent system key (as the Build mints it) allows the three roles; a remap changes its next call, with no key change', { skip }, async () => {
  const system = parseSystem(`
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants: { tools: [retrieve] }
agents:
  - { id: worker, role: w, agent_md: "# W", memory_md: "", tools: [retrieve], model: auto }
`);
  const want = await keyWanted({ runModels: () => [] } as Parameters<typeof keyWanted>[0])({ system, ir: compile(system), systemId: 'sys_sw' });
  for (const r of ROLE_NAMES) assert.ok(want.models.includes(r), `the OS's key wants ${r}`);
  const key = await newKey(want.models, 'os-sys-sw');
  const before = await keyInfo(key);

  assert.equal((await chat(key, 'sovereign-strong')).content, `from-${A}`);
  assert.equal((await chat(key, 'sovereign-worker')).content, `from-${W}`);

  await applyRoleMapping(io(), { 'sovereign-strong': B, 'sovereign-worker': W, 'sovereign-embedding': E }, 'admin1');
  assert.equal((await chat(key, 'sovereign-strong')).content, `from-${B}`, 'remapped: the same key, the very next call, the new model');

  const after2 = await keyInfo(key);
  assert.equal(after2.token, before.token, 'same key');
  assert.deepEqual(after2.models, before.models, 'the key was not rebuilt or edited');
});

test('REAL GATEWAY: spend is booked on the key and per model, under a role', { skip }, async () => {
  const key = await newKey([...ROLE_NAMES], 'os-sys-spend');
  await chat(key, 'sovereign-strong'); await chat(key, 'sovereign-worker');
  await new Promise((r) => setTimeout(r, 4000)); // LiteLLM writes spend in batches
  const info = await keyInfo(key);
  assert.ok(info.spend > 0, `key spend moved: ${info.spend}`);
  const logs = (await (await admin(`/spend/logs?api_key=${encodeURIComponent(info.token)}`, undefined, 'GET')).json()) as { model?: string; model_group?: string; spend?: number }[];
  assert.ok(Array.isArray(logs) && logs.length >= 2, JSON.stringify(logs).slice(0, 300));
  const byModel = new Set(logs.map((l) => l.model_group ?? l.model));
  assert.ok(byModel.has('sovereign-strong') || byModel.has(B), `spend row names the role or its model: ${[...byModel].join(',')}`);
  assert.ok(logs.every((l) => (l.spend ?? 0) > 0), 'every call carries a cost');
});

test('REAL GATEWAY: NEGATIVE TWIN — a key WITHOUT the role names is refused, so the allowlist is what makes a remap work', { skip }, async () => {
  const key = await newKey([A], 'os-sys-narrow');
  const r = await chat(key, 'sovereign-strong');
  assert.ok(r.status === 401 || r.status === 403 || r.status === 400, `refused, got ${r.status}`);
  assert.equal(r.content, undefined);
});

test('REAL GATEWAY: NEGATIVE TWIN — a mapping to a model outside the catalog changes nothing for the key', { skip }, async () => {
  const key = await newKey([...ROLE_NAMES], 'os-sys-neg');
  await assert.rejects(applyRoleMapping(io(), { 'sovereign-strong': 'ghost', 'sovereign-worker': W, 'sovereign-embedding': E }, 'admin1'), (e: unknown) => e instanceof ModelMappingError);
  assert.equal((await chat(key, 'sovereign-strong')).content, `from-${B}`);
});
