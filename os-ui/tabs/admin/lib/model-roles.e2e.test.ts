/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The OS-owned role mapping, enforced at the REAL LiteLLM image through `router_settings.model_group_alias`.
 * USER STORY: As the owner I need proof from the real gateway that remapping `sovereign-strong` in the OS
 *             changes the very next model call with no restart and no chart change, that a foreign edit
 *             in LiteLLM is repaired and reported, that a mapping to a missing model is refused, that a
 *             catalog model removed under a role is a typed failure and a warning (never a silent
 *             fallback), and that an old alias still works and logs a deprecation.
 * ARCHITECTURE:
 *   - Runs ONLY against the containers started by scripts/tests/gateway-models/run.sh (the chart's LiteLLM
 *     image on Postgres, started like the chart: a `model_list` file AND `store_model_in_db`, and — as the
 *     chart renders it — NO `model_group_alias` in the file). Without them the suite SKIPS; with
 *     GATEWAY_MODELS_E2E_REQUIRED=1 a missing gateway is a FAILURE.
 *   - Catalog models are DB models with `mock_response`, so a call returns "from-<name>" without any
 *     provider: the answer proves WHICH catalog model the role resolved to. Calls go to the gateway the way
 *     any caller's would (`/v1/chat/completions`, model = the role name).
 *   - The OS side is production code: `applyRoleMapping` / `reconcileRoleMapping` over `liveRoleIo` — the real
 *     LiteLLM admin client and the platform repository as a real git repository in a temp directory.
 *   - The "platform team" acts only through LiteLLM's own API (`/model/new`, `/model/delete`, `/config/update`).
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

const reposDir = mkdtempSync(join(tmpdir(), 'os-roles-e2e-'));
const { liveRoleIo } = await import('@core/models/role-live');
const { applyRoleMapping, reconcileRoleMapping } = await import('@core/models/role-reconcile');
const { ModelMappingError } = await import('@core/models/role-mapping');
const { platformRoleStore, MODELS_FILE } = await import('@core/models/role-store');
const { readGatewayCatalog } = await import('@core/models/gateway-catalog');
const { log, readBlob } = await import('@core/infra/git-store');
const { PLATFORM_REPO } = await import('@core/infra/repo-layout');
const { roleModel } = await import('@core/models/roles');
const { updateSettings } = await import('@tabs/admin/lib/settings');
const io = () => liveRoleIo({ reposDir });

const admin = (path: string, body: unknown) =>
  fetch(`${GW}${path}`, { method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chat = async (model: string) => {
  const res = await fetch(`${GW}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string; type?: string } };
  return { status: res.status, content: body.choices?.[0]?.message?.content, error: body.error };
};
const sfx = randomBytes(3).toString('hex');
const A = `role-a-${sfx}`, B = `role-b-${sfx}`, E = `role-emb-${sfx}`;
const modelIds = new Map<string, string>();
async function addModel(name: string, mode: 'chat' | 'embedding' = 'chat') {
  const r = await admin('/model/new', { model_name: name, // LiteLLM "custom pricing" goes in litellm_params (1.109.1 drops it from model_info on /model/new) — as the OS wizard does.
    litellm_params: { model: 'openai/stub', api_key: 'unused', mock_response: `from-${name}`, input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 }, model_info: { mode } });
  assert.equal(r.status, 200, await r.text());
  const info = (await (await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } })).json()) as { data: { model_name: string; model_info: { id: string } }[] };
  modelIds.set(name, info.data.find((m) => m.model_name === name)!.model_info.id);
}
const mapping = (strong: string) => ({ 'sovereign-strong': strong, 'sovereign-worker': B, 'sovereign-embedding': E });

after(async () => {
  for (const id of modelIds.values()) await admin('/model/delete', { id });
  await admin('/config/update', { router_settings: { model_group_alias: {} } });
  rmSync(reposDir, { recursive: true, force: true });
});

test('REAL GATEWAY: the catalog entries carry their real per-token price (read from LiteLLM, per 1M tokens)', { skip }, async () => {
  await addModel(A); await addModel(B); await addModel(E, 'embedding');
  const cat = await readGatewayCatalog();
  assert.ok(cat.ok);
  const a = cat.ok && cat.data.models.find((m) => m.name === A);
  assert.deepEqual(a && a.cost, { inputPerM: 2, outputPerM: 8 });
});

test('REAL GATEWAY: mapping a role in the OS makes the NEXT call resolve to that model; a remap takes effect with no restart', { skip }, async () => {
  const first = await applyRoleMapping(io(), mapping(A), 'admin1');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await chat('sovereign-strong')).content, `from-${A}`);
  assert.equal((await chat('sovereign-worker')).content, `from-${B}`);

  await applyRoleMapping(io(), mapping(B), 'admin1');
  assert.equal((await chat('sovereign-strong')).content, `from-${B}`, 'remapped: the very next call uses the new model, no restart, no chart change');
  // the file is the record: committed by the admin, restorable
  assert.deepEqual((await platformRoleStore({ reposDir }).read())!['sovereign-strong'], B);
  const commits = await log(PLATFORM_REPO, { reposDir });
  assert.ok(commits.length >= 2 && commits.every((c) => /role mapping/.test(c.message)));
  assert.match(await readBlob(PLATFORM_REPO, commits[1].sha, MODELS_FILE, { reposDir }), new RegExp(`sovereign-strong: ${A}`));
});

test('REAL GATEWAY: an OLD alias still works (it means its role) and logs a deprecation', { skip }, async () => {
  for (const [old, want] of [['sovereign-reasoning', B], ['sovereign-premium', B], ['sovereign-vision', B], ['sovereign-embed', E]] as const) {
    assert.equal((await chat(old)).content, `from-${want}`, old);
  }
  // NEGATIVE TWIN: a deprecated name that is a real catalog model (the config-file `sovereign-default`) is not aliased over.
  const cat = await readGatewayCatalog();
  assert.ok(cat.ok && cat.data.models.some((m) => m.name === 'sovereign-default'));
  const aliases = await io().readAliases();
  assert.ok(aliases.ok && !('sovereign-default' in aliases.data), 'the real model wins');
  // the deprecation log: a setting that still names an old alias
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (l: string) => { lines.push(String(l)); };
  try {
    updateSettings({ modelRoles: { reasoning: 'sovereign-premium' } });
    assert.equal(roleModel('reasoning'), 'sovereign-premium', 'the OS does no client-side resolution');
  } finally { console.warn = warn; }
  assert.ok(lines.some((l) => /deprecated.*sovereign-premium.*sovereign-strong/.test(l)), lines.join('|'));
});

test('REAL GATEWAY: a FOREIGN edit of the alias in LiteLLM is repaired by the OS and reported', { skip }, async () => {
  const r = await admin('/config/update', { router_settings: { model_group_alias: { 'sovereign-strong': A } } });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await chat('sovereign-strong')).content, `from-${A}`, 'precondition: the foreign edit is live');
  const rep = await reconcileRoleMapping(io());
  assert.equal(rep.state, 'repaired', JSON.stringify(rep));
  assert.ok(rep.drift.some((d) => d.alias === 'sovereign-strong' && d.have === A && d.want === B), JSON.stringify(rep.drift));
  assert.equal((await chat('sovereign-strong')).content, `from-${B}`, 'repaired');
  assert.equal((await reconcileRoleMapping(io())).state, 'in-sync', 'a second pass writes nothing');
});

test('REAL GATEWAY: a mapping to a model that is not in the catalog is refused (typed) and nothing changes', { skip }, async () => {
  await assert.rejects(applyRoleMapping(io(), mapping('ghost-model'), 'admin1'), (e: unknown) => e instanceof ModelMappingError && e.code === 'unknown_catalog_model' && e.model === 'ghost-model');
  assert.equal((await platformRoleStore({ reposDir }).read())!['sovereign-strong'], B, 'the file is unchanged');
  assert.equal((await chat('sovereign-strong')).content, `from-${B}`, 'and so is the gateway');
});

test('REAL GATEWAY: a catalog model removed while a role points at it is a typed failure and a warning — never a silent fallback', { skip }, async () => {
  assert.equal((await admin('/model/delete', { id: modelIds.get(B)! })).status, 200);
  modelIds.delete(B);
  const rep = await reconcileRoleMapping(io());
  assert.equal(rep.state, 'blocked');
  assert.ok(rep.missing.some((m) => m.role === 'sovereign-strong' && m.model === B));
  assert.equal(rep.roles.find((x) => x.role === 'sovereign-strong')!.inCatalog, false);
  const call = await chat('sovereign-strong');
  assert.equal(call.status, 400, 'the gateway answers with its own typed error');
  assert.equal(call.content, undefined, 'and does not answer from another model');
  assert.match(String(call.error?.message), /no healthy deployments|not found|invalid/i);
  const aliases = await io().readAliases();
  assert.ok(aliases.ok && aliases.data['sovereign-strong'] === B, 'the alias was not silently re-pointed');
});
