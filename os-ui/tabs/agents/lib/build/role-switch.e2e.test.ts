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
import { createHash, randomBytes } from 'node:crypto';

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
const { migrateRoleKeys } = await import('@tabs/agents/lib/build/role-key-migration');
const { realRoleKeyClient } = await import('@core/infra/litellm-role-keys');
const { deriveKek, memorySystemKeyJournal, memorySystemKeyStore, sealSystemKey, tokenIdOf } = await import('@core/infra/agent-system-keys');
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
const idOf = new Map<string, string>();
const keys: string[] = [];
async function addModel(name: string, mode: 'chat' | 'embedding' = 'chat') {
  const r = await admin('/model/new', { model_name: name, litellm_params: { model: 'openai/stub', api_key: 'unused', mock_response: `from-${name}`, input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 }, model_info: { mode } });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const info = (await (await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } })).json()) as { data: { model_name: string; model_info: { id: string } }[] };
  const id = info.data.find((m) => m.model_name === name)!.model_info.id;
  modelIds.push(id);
  idOf.set(name, id);
}
async function newKey(models: string[], alias: string) {
  const r = await admin('/key/generate', { models, key_alias: `${alias}-${sfx}`, max_budget: 5, budget_duration: '7d' });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const k = JSON.parse(text) as { key: string; token?: string };
  keys.push(k.key);
  return k.key;
}
const keyInfo = async (key: string) => ((await (await admin(`/key/info?key=${encodeURIComponent(key)}`, undefined, 'GET')).json()) as { info: { models: string[]; spend: number; token?: string; key_name: string } }).info;

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

// An agent system's key allows the role NAMES its agents run on (`agentRoles`: here one Strong and one Standard agent),
// so a remap of a role needs no key change.
const TWO_ROLE_YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: lead
grants: { tools: [retrieve] }
agents:
  - { id: lead, role: l, agent_md: "# L", memory_md: "", tools: [retrieve], model: strong }
  - { id: worker, role: w, agent_md: "# W", memory_md: "", tools: [retrieve], model: standard }
edges:
  - { from: lead, to: worker, type: handoff }
`;

test('REAL GATEWAY: an agent system key (as the Build mints it) allows the roles its agents use; a remap changes its next call, with no key change', { skip }, async () => {
  const system = parseSystem(TWO_ROLE_YAML);
  const want = await keyWanted({} as Parameters<typeof keyWanted>[0])({ system, ir: compile(system), systemId: 'sys_sw' });
  assert.deepEqual([...want.models].sort(), ['sovereign-strong', 'sovereign-worker'], 'exactly the roles the agents run on');
  const key = await newKey(want.models, 'os-sys-sw');
  const before = await keyInfo(key);

  assert.equal((await chat(key, 'sovereign-strong')).content, `from-${A}`);
  assert.equal((await chat(key, 'sovereign-worker')).content, `from-${W}`);

  await applyRoleMapping(io(), { 'sovereign-strong': B, 'sovereign-worker': W, 'sovereign-embedding': E }, 'admin1');
  assert.equal((await chat(key, 'sovereign-strong')).content, `from-${B}`, 'remapped: the same key, the very next call, the new model');

  const after2 = await keyInfo(key);
  assert.equal(after2.key_name, before.key_name, 'same key');
  assert.deepEqual(after2.models, before.models, 'the key was not rebuilt or edited');
});

test('REAL GATEWAY: spend is booked on the key, per ROLE (model_group) and per catalog MODEL (model_id)', { skip }, async () => {
  const key = await newKey([...ROLE_NAMES], 'os-sys-spend');
  await chat(key, 'sovereign-strong'); await chat(key, 'sovereign-worker');
  const hashed = createHash('sha256').update(key).digest('hex');
  type Row = { model_group?: string; model_id?: string; spend?: number };
  let logs: Row[] = [];
  let spend = 0;
  for (let i = 0; i < 40 && (logs.length < 2 || spend <= 0); i++) { // LiteLLM writes spend in batches
    await new Promise((r) => setTimeout(r, 2000));
    logs = (await (await admin(`/spend/logs?api_key=${hashed}`, undefined, 'GET')).json()) as Row[];
    spend = (await keyInfo(key)).spend;
  }
  assert.ok(spend > 0, `the key's spend moved: ${spend}`);
  assert.ok(Array.isArray(logs) && logs.length >= 2, JSON.stringify(logs).slice(0, 300));
  const strong = logs.find((l) => l.model_group === 'sovereign-strong')!;
  const worker = logs.find((l) => l.model_group === 'sovereign-worker')!;
  assert.equal(strong.model_id, idOf.get(B), 'the strong call is booked on the catalog model strong means now');
  assert.equal(worker.model_id, idOf.get(W), 'the worker call on its own model');
  assert.ok((strong.spend ?? 0) > 0 && (worker.spend ?? 0) > 0, 'every call carries a cost (the catalog entry\'s own price)');
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

test('REAL GATEWAY: keys minted BEFORE the switch — the migration adds the roles (dry run first), and they call sovereign-strong with no rebuild; keys the OS does not own are untouched', { skip }, async () => {
  const OLD = ['sovereign-default', 'sovereign-reasoning', 'sovereign-embed'];
  const kek = deriveKek('e2e-key-encryption-secret-0123456789abcdef');
  const store = memorySystemKeyStore();
  const mint = async (alias: string, models: string[], value: string) => {
    const r = await admin('/key/generate', { key: value, models, key_alias: alias, max_budget: 7, budget_duration: '7d', rpm_limit: 111 });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    keys.push(value);
  };
  const sysValue = `sk-pre-sys-${sfx}-${randomBytes(8).toString('hex')}`;
  const sharedValue = `sk-pre-shared-${sfx}-${randomBytes(8).toString('hex')}`;
  const strangerValue = `sk-stranger-${sfx}-${randomBytes(8).toString('hex')}`;
  const impostorValue = `sk-impostor-${sfx}-${randomBytes(8).toString('hex')}`;
  await mint(`os-sys_pre${sfx}`, OLD, sysValue);
  await mint(`sovereign-agents-${sfx}`, OLD, sharedValue);
  await mint(`someone-elses-${sfx}`, ['sovereign-default'], strangerValue);
  await mint(`os-sys_imp${sfx}`, ['sovereign-default'], impostorValue); // an os-<id> alias, but not the key the OS stored
  await store.put(sealSystemKey({ systemId: `sys_pre${sfx}`, alias: `os-sys_pre${sfx}`, key: sysValue, caps: { models: OLD, maxBudget: 7, budgetDuration: '7d', rpmLimit: 111, tpmLimit: 1, maxParallelRequests: 8 }, createdAt: 1, rotatedAt: null }, kek));
  await store.put(sealSystemKey({ systemId: `sys_imp${sfx}`, alias: `os-sys_imp${sfx}`, key: `sk-the-stored-one-${sfx}`, caps: { models: [], maxBudget: 7, budgetDuration: '7d', rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1 }, createdAt: 1, rotatedAt: null }, kek));
  const mio = () => ({
    systems: async () => [
      { id: `sys_pre${sfx}`, domain: 'sales', owner: 'u1', yaml: TWO_ROLE_YAML },
      { id: `sys_imp${sfx}`, domain: 'sales', owner: 'u1', yaml: TWO_ROLE_YAML },
    ],
    deps: { keys: { store, journal: memorySystemKeyJournal(), kek: () => kek, retireGraceSeconds: 0 }, litellm: realRoleKeyClient() },
    sharedKey: sharedValue,
    log: () => undefined,
    audit: (() => undefined) as never,
  });

  // BEFORE: the pre-switch keys are refused on a role (the allowlist is what the migration fixes)
  assert.ok([400, 401, 403].includes((await chat(sysValue, 'sovereign-strong')).status));
  const sysBefore = await keyInfo(sysValue);

  // DRY RUN: the plan, no write
  const plan = await migrateRoleKeys(mio(), { dryRun: true });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.changed.map((c) => c.subject).sort(), [`os-sys_pre${sfx}`, 'shared agent key']);
  assert.deepEqual((await keyInfo(sysValue)).models, sysBefore.models, 'a dry run wrote nothing');
  assert.ok([400, 401, 403].includes((await chat(sysValue, 'sovereign-strong')).status));

  // APPLY
  const done = await migrateRoleKeys(mio());
  assert.equal(done.ok, true, JSON.stringify(done));
  for (const v of [sysValue, sharedValue]) {
    const info = await keyInfo(v);
    // The shared key gets all three roles; a system key the roles its agents run on (strong + worker here).
    for (const r of v === sharedValue ? ROLE_NAMES : ['sovereign-strong', 'sovereign-worker']) assert.ok(info.models.includes(r), `${r} on the key`);
    if (v === sysValue) assert.ok(!info.models.includes('sovereign-embedding'), 'no role the agents do not use');
    for (const m of OLD) assert.ok(info.models.includes(m), `${m} kept`);
    assert.equal((await chat(v, 'sovereign-strong')).content, `from-${B}`, 'the key minted before the switch calls the role, with no rebuild');
    assert.equal((await chat(v, 'sovereign-worker')).content, `from-${W}`);
  }
  // nothing else on the key moved, and it is the same key (the same value still works)
  const sysAfter = await keyInfo(sysValue);
  assert.equal(sysAfter.key_name, sysBefore.key_name);
  const raw = (await (await admin(`/key/info?key=${encodeURIComponent(sysValue)}`, undefined, 'GET')).json()) as { info: { max_budget: number; rpm_limit: number; budget_duration: string } };
  assert.deepEqual([raw.info.max_budget, raw.info.rpm_limit, raw.info.budget_duration], [7, 111, '7d']);

  // IDEMPOTENT
  assert.deepEqual((await migrateRoleKeys(mio())).changed, []);

  // NEGATIVE TWINS: the keys the OS does not own are exactly as they were
  assert.deepEqual((await keyInfo(strangerValue)).models, ['sovereign-default']);
  assert.deepEqual((await keyInfo(impostorValue)).models, ['sovereign-default']);
  assert.ok(done.skipped.some((x) => x.subject === `os-sys_imp${sfx}`), JSON.stringify(done.skipped));
  void tokenIdOf;
});
