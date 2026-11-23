/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The system key never fails a run: its OS-derived fields follow the definition on save and before every run
 * USER STORY: As the owner I edit a grant or switch an agent to Standard and run at once — no "Rebuild needed", no
 *             gateway refusal — and the key's budget and limits stay exactly as an admin left them.
 * ARCHITECTURE: the REAL `syncDerivedKeyFields` / `installKeySyncOnSave` (`key-reconcile.ts`) over the Build's own
 *             litellm step and a LiteLLM-shaped key store (the same fake the key-reconcile tests use); `keyWanted` is
 *             the comparison. Twins: in sync → no write, no audit; gateway down → no throw, typed `unreachable`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKek, memorySystemKeyJournal, memorySystemKeyStore, tokenIdOf } from '@core/infra/agent-system-keys';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiteLlmClient, type LiteLlmKeyInput, type LiteLlmKeyState, type LiveDeps } from '@tabs/agents/lib/build/live';
import { installKeySyncOnSave, syncDerivedKeyFields } from '@tabs/agents/lib/build/key-reconcile';
import { ALLOWED_TOOLS_REV } from '@tabs/agents/lib/build/run-tools';
import { emitSystemChange, __resetSystemListeners } from '@tabs/agents/lib/system-events';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [search_knowledge]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", model: strong }
`;
const KEK = deriveKek('unit-test-key-encryption-secret-0123456789');

type Gw = LiteLlmClient & { rows: Map<string, LiteLlmKeyState[]>; updates: number; unreachable: boolean };
function gateway(): Gw {
  const rows = new Map<string, LiteLlmKeyState[]>();
  const state = (i: LiteLlmKeyInput, tokenId: string): LiteLlmKeyState => ({
    tokenId, models: [...i.models], maxBudget: i.maxBudget, budgetDuration: i.budgetDuration, rpmLimit: i.rpmLimit,
    tpmLimit: i.tpmLimit, maxParallelRequests: i.maxParallelRequests, allowedTools: [...i.allowedTools], allowedToolsRev: ALLOWED_TOOLS_REV,
  });
  const gw: Gw = {
    rows, updates: 0, unreachable: false,
    async keysByAlias(alias) {
      if (gw.unreachable) throw new Error('LiteLLM /key/list failed (unreachable)');
      return (rows.get(alias) ?? []).map((k) => ({ ...k }));
    },
    async generateKey(i, key) { rows.set(i.alias, [...(rows.get(i.alias) ?? []), state(i, tokenIdOf(key))]); },
    async updateKey(tokenId, i) {
      if (gw.unreachable) throw new Error('LiteLLM /key/update failed (unreachable)');
      gw.updates += 1;
      for (const [a, ks] of rows) rows.set(a, ks.map((k) => (k.tokenId === tokenId ? state(i, tokenId) : k)));
    },
    async deleteKey() {}, async renameKey() {}, async expireKey() {}, async models() { return []; },
  };
  return gw;
}

function setup() {
  const gw = gateway();
  const deps: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm: gw,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    keys: { store: memorySystemKeyStore(), journal: memorySystemKeyJournal(), kek: () => KEK, retireGraceSeconds: 0 },
    caps: { maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 },
  };
  const audits: { action: string; subject: string; detail?: Record<string, unknown> }[] = [];
  const build = () => orchestrateBuild({ yaml: YAML, systemId: 'sys_ks', adapters: makeLiveAdapters(deps).filter((a) => a.tool === 'litellm') });
  const key = () => gw.rows.get('os-sys_ks')![0];
  const sync = (yaml: string, cause: 'pre-run-sync' | 'save-sync' = 'pre-run-sync') =>
    syncDerivedKeyFields({ systemId: 'sys_ks', yaml, domain: 'sales', actor: 'user:u1', cause, deps, audit: ((e: never) => { audits.push(e); }) as never });
  return { gw, deps, audits, build, key, sync };
}

test('GRANT EDITED AFTER BUILD: before the run the key gets the new tool (audited pre-run-sync); budget and limits untouched', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 42; // an admin raised it in LiteLLM: not OS-derived here, never overwritten
  const edited = YAML.replace('tools: [search_knowledge]', 'tools: [search_knowledge, query_data]');
  const out = await t.sync(edited);
  assert.equal(out.state, 'synced');
  assert.ok(t.key().allowedTools!.includes('query_data'), t.key().allowedTools!.join(','));
  assert.equal(t.key().maxBudget, 42);
  const a = t.audits.find((x) => x.action === 'gateway.key.reconcile');
  assert.equal(a?.detail?.cause, 'pre-run-sync');
});

test('MODEL CHANGED: saving an agent on Standard re-stamps the key\'s models (save hook, audited save-sync)', async () => {
  const t = setup();
  await t.build();
  assert.deepEqual(t.key().models, ['sovereign-strong']);
  __resetSystemListeners();
  let saved = YAML;
  const seen: unknown[] = [];
  const off = installKeySyncOnSave(async () => { seen.push(await t.sync(saved, 'save-sync')); });
  saved = YAML.replace('model: strong', 'model: standard');
  emitSystemChange({ domain: 'sales', systemId: 'sys_ks', name: 'Desk', action: 'edit system.yaml', actorId: 'u1' });
  await new Promise((r) => setTimeout(r, 20));
  off();
  assert.deepEqual(t.key().models, ['sovereign-worker']);
  assert.equal((seen[0] as { state: string }).state, 'synced');
  assert.equal(t.audits.at(-1)?.detail?.cause, 'save-sync');
});

test('TWIN: a key already in sync is not written and nothing is audited (no noise)', async () => {
  const t = setup();
  await t.build();
  const before = t.gw.updates;
  assert.equal((await t.sync(YAML)).state, 'in-sync');
  assert.equal(t.gw.updates, before);
  assert.equal(t.audits.length, 0);
});

test('LITELLM DOWN: no throw — `unreachable` with the reason, so the run proceeds and the gateway answers it', async () => {
  const t = setup();
  await t.build();
  t.gw.unreachable = true;
  const out = await t.sync(YAML.replace('model: strong', 'model: standard'));
  assert.equal(out.state, 'unreachable');
  assert.match((out as { error: string }).error, /unreachable/);
  assert.equal(t.audits.length, 0);
});

test('TWIN: a system never built is left alone (no key to stamp)', async () => {
  const t = setup();
  assert.equal((await t.sync(YAML)).state, 'not-built');
  assert.equal(t.gw.updates, 0);
});
