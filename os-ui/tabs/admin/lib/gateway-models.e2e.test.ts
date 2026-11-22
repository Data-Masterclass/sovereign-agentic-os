/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The OS model list follows LiteLLM, proven against the REAL LiteLLM image.
 * USER STORY: As the owner I need proof from the real gateway, not a fake, that a model added in
 *             LiteLLM appears in the OS model picker and Platform → Models & Providers with no OS
 *             change, that one removed disappears, and that the OS tells a config-file model from a
 *             database one and never shows a credential value.
 * ARCHITECTURE:
 *   - Runs ONLY against the containers started by scripts/tests/gateway-models/run.sh (the chart's
 *     LiteLLM image on a real Postgres, started the way the chart does: a `model_list` config file AND
 *     `store_model_in_db`). Without them the suite SKIPS, saying so; with GATEWAY_MODELS_E2E_REQUIRED=1
 *     a missing gateway is a FAILURE.
 *   - The "platform team" acts through LiteLLM's own admin API (`/credentials`, `/model/new`,
 *     `/model/delete`), exactly as its UI does. The OS side is the production code: the model route
 *     `GET /api/agents/models` (auth mocked, everything else real) over `readGatewayCatalog` and the
 *     real LiteLLM client, and the OS's own removal flow (`removeGatewayModel`).
 *   - NEGATIVE TWINS: the old seed aliases never appear unless LiteLLM lists them; a config-file model
 *     is refused by the OS and by LiteLLM; the credential's secret never appears in the OS answer.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const MASTER = process.env.LITELLM_MASTER_KEY ?? '';
const REQUIRED = process.env.GATEWAY_MODELS_E2E_REQUIRED === '1';
if (REQUIRED && (!GW || !MASTER)) throw new Error('GATEWAY_MODELS_E2E_REQUIRED=1 but LITELLM_URL / LITELLM_MASTER_KEY are not set');
const skip = GW && MASTER && REQUIRED ? false : 'run scripts/tests/gateway-models/run.sh (needs the real LiteLLM image)';

mock.module('@core/kernel/auth', { namedExports: { requireUser: async () => ({ id: 'u1', name: 'Admin', domains: [], role: 'admin' }) } });
const route = await import('../../../app/api/agents/models/route.ts');
const { removeGatewayModel } = await import('@tabs/admin/lib/model-remove');
const { readGatewayCatalog } = await import('@core/models/gateway-catalog');

const admin = (path: string, body: unknown) =>
  fetch(`${GW}${path}`, { method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Row = { model_name: string; management: string; credentials: string[]; mode: string };
type Body = { models: Row[]; credentials: { name: string; models: string[] }[] | null; source: string };
const picker = async () => (await (await route.GET()).json()) as Body;
const names = (b: Body) => b.models.map((m) => m.model_name).sort();
const SECRET = `sk-e2e-secret-${randomBytes(8).toString('hex')}`;

/** The id LiteLLM gave a model (its own /model/info), for the platform team's delete. */
async function modelId(alias: string): Promise<string> {
  const res = await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } });
  const rows = ((await res.json()) as { data: { model_name: string; model_info: { id: string; db_model: boolean } }[] }).data;
  const row = rows.find((r) => r.model_name === alias && r.model_info.db_model);
  assert.ok(row, `LiteLLM has no database model ${alias}`);
  return row.model_info.id;
}

test('REAL GATEWAY: the model the config file sets is listed as config-managed; the old seed aliases are not invented', { skip }, async () => {
  const b = await picker();
  assert.equal(b.source, 'litellm');
  assert.deepEqual(names(b), ['sovereign-default'], 'exactly what LiteLLM lists — no sovereign-reasoning / -embed / -mock seed');
  assert.equal(b.models[0].management, 'config');
});

test('REAL GATEWAY: a model added through LiteLLM\'s own API appears in the OS with no OS change — and disappears when LiteLLM removes it', { skip }, async () => {
  const alias = `acme-${randomBytes(3).toString('hex')}`;
  const cred = `conn-${randomBytes(3).toString('hex')}`;
  let r = await admin('/credentials', { credential_name: cred, credential_values: { api_key: SECRET }, credential_info: { custom_llm_provider: 'openai' } });
  assert.equal(r.status, 200, await r.text());
  r = await admin('/model/new', { model_name: alias, litellm_params: { model: 'openai/gpt-e2e', litellm_credential_name: cred }, model_info: { access_groups: ['os-admin-registered'] } });
  assert.equal(r.status, 200, await r.text());

  const added = await picker();
  const row = added.models.find((m) => m.model_name === alias);
  assert.ok(row, `the OS list does not show ${alias}: ${names(added)}`);
  assert.equal(row.management, 'database');
  assert.deepEqual(row.credentials, [cred], 'the connection LiteLLM holds for the model');
  assert.deepEqual(added.credentials?.find((c) => c.name === cred)?.models, [alias]);
  assert.ok(!JSON.stringify(added).includes(SECRET), 'the credential value never reaches the OS answer');
  assert.ok(!JSON.stringify(added).includes('credential_values'));
  assert.equal(added.models.find((m) => m.model_name === 'sovereign-default')?.management, 'config');

  // The platform team removes it in LiteLLM.
  r = await admin('/model/delete', { id: await modelId(alias) });
  assert.equal(r.status, 200, await r.text());
  assert.ok(!names(await picker()).includes(alias), 'a model removed in LiteLLM is gone from the OS list');
});

test('REAL GATEWAY: the OS\'s own removal flow deletes a database model in LiteLLM and refuses a config-file model', { skip }, async () => {
  const alias = `rm-${randomBytes(3).toString('hex')}`;
  assert.equal((await admin('/model/new', { model_name: alias, litellm_params: { model: 'openai/gpt-e2e', api_base: 'http://127.0.0.1:9/v1', api_key: 'unused' } })).status, 200);
  assert.ok(names(await picker()).includes(alias));
  const out = await removeGatewayModel(alias);
  assert.equal(out.status, 'removed');
  assert.ok(!names(await picker()).includes(alias), 'removed through the OS flow = removed in LiteLLM = gone from the list');

  // NEGATIVE TWIN: the config-file model.
  const refused = await removeGatewayModel('sovereign-default');
  assert.equal(refused.status, 'managed');
  assert.ok(names(await picker()).includes('sovereign-default'), 'still listed');
  // …and LiteLLM itself cannot delete it either (the file is authoritative): which is why the OS shows it as config.
  const info = await (await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } })).json() as { data: { model_name: string; model_info: { id: string } }[] };
  const cfgId = info.data.find((m) => m.model_name === 'sovereign-default')!.model_info.id;
  const direct = await admin('/model/delete', { id: cfgId });
  assert.notEqual(direct.status, 200, 'LiteLLM refuses to delete a config-file model');
  assert.ok(names(await picker()).includes('sovereign-default'));
});

test('REAL GATEWAY: an alias served by the config file AND the database is "mixed", and the OS will not remove it', { skip }, async () => {
  assert.equal((await admin('/model/new', { model_name: 'sovereign-default', litellm_params: { model: 'openai/other', api_base: 'http://127.0.0.1:9/v1', api_key: 'unused' } })).status, 200);
  try {
    const b = await picker();
    assert.equal(b.models.find((m) => m.model_name === 'sovereign-default')!.management, 'mixed');
    assert.equal((await removeGatewayModel('sovereign-default')).status, 'managed');
  } finally {
    const info = await (await fetch(`${GW}/model/info`, { headers: { authorization: `Bearer ${MASTER}` } })).json() as { data: { model_name: string; model_info: { id: string; db_model: boolean } }[] };
    for (const m of info.data.filter((x) => x.model_name === 'sovereign-default' && x.model_info.db_model)) await admin('/model/delete', { id: m.model_info.id });
  }
  assert.equal((await readGatewayCatalog()).ok && (await picker()).models.find((m) => m.model_name === 'sovereign-default')!.management, 'config');
});
