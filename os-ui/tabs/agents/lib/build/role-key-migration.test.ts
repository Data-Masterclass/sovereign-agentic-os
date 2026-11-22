/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A boot migration adds the three role names to the keys the OS owns, so keys minted before the switch keep working.
 * USER STORY: As an operator I upgrade to the role names and every agent system and the shared agent key can
 *             call sovereign-strong / -worker / -embedding at once, with no rebuild — and nothing else about a key moves.
 * ARCHITECTURE:
 *   - ADDS ONLY: a key's models become (what it had) + (the roles it lacks). Nothing is removed, the key value and
 *     every other property are untouched (the update sends `models` and nothing else). Idempotent: a key that has
 *     the roles is not written. Dry run: the same plan, no write.
 *   - OWNED KEYS ONLY: the shared key (the one whose value the OS holds) and each registered system's key whose token
 *     is the one the OS stored. A key under an `os-<id>` alias that is not that token, a key in no registry, and an
 *     unrestricted key (no model list = every model) are never touched.
 *   - Audited per key (`gateway.key.reconcile`). With the migration done, the key reconcile reports no drift.
 *   - The gateway here is an in-memory fake with LiteLLM's key semantics; the same migration is proven on the real
 *     LiteLLM image in `tabs/admin/lib/role-switch.e2e.test.ts`. Each behaviour has a negative twin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKek, memorySystemKeyJournal, memorySystemKeyStore, tokenIdOf } from '@core/infra/agent-system-keys';
import { ROLE_NAMES } from '@core/models/role-names';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiteLlmClient, type LiteLlmKeyInput, type LiteLlmKeyState, type LiveDeps } from '@tabs/agents/lib/build/live';
import { runKeyReconcile, type KeyReconcileIo } from '@tabs/agents/lib/build/key-reconcile';
import { migrateRoleKeys, type RoleKeyClient, type RoleKeyMigrationIo } from '@tabs/agents/lib/build/role-key-migration';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: auto }
`;
const KEK = deriveKek('unit-test-key-encryption-secret-0123456789');
const OLD = ['sovereign-default', 'sovereign-reasoning', 'sovereign-mock', 'sovereign-embed'];
const SHARED_VALUE = 'sk-shared-agent-key-test-value';

type Gw = LiteLlmClient & RoleKeyClient & { rows: Map<string, LiteLlmKeyState[]>; updates: { tokenId: string; models: string[] }[]; unreachable: boolean; fullUpdates: number };

function gateway(): Gw {
  const rows = new Map<string, LiteLlmKeyState[]>();
  const state = (i: LiteLlmKeyInput, tokenId: string): LiteLlmKeyState => ({
    tokenId, models: [...i.models], maxBudget: i.maxBudget, budgetDuration: i.budgetDuration, rpmLimit: i.rpmLimit,
    tpmLimit: i.tpmLimit, maxParallelRequests: i.maxParallelRequests, allowedTools: [...i.allowedTools],
  });
  const gw: Gw = {
    rows, updates: [], unreachable: false, fullUpdates: 0,
    async keysByAlias(alias) {
      if (gw.unreachable) throw new Error('LiteLLM /key/list failed (unreachable)');
      return (rows.get(alias) ?? []).map((k) => ({ ...k }));
    },
    async generateKey(i, key) { rows.set(i.alias, [...(rows.get(i.alias) ?? []), state(i, tokenIdOf(key))]); },
    async updateKey(tokenId, i) { gw.fullUpdates += 1; for (const [a, ks] of rows) rows.set(a, ks.map((k) => (k.tokenId === tokenId ? state(i, tokenId) : k))); },
    async deleteKey() {}, async renameKey() {}, async expireKey() {}, async models() { return []; },
    async keyInfo(tokenId) {
      if (gw.unreachable) throw new Error('LiteLLM /key/info failed (unreachable)');
      for (const [alias, ks] of rows) { const k = ks.find((x) => x.tokenId === tokenId); if (k) return { alias, models: [...k.models] }; }
      return null;
    },
    async addKeyModels(tokenId, models) {
      gw.updates.push({ tokenId, models: [...models] });
      for (const ks of rows.values()) for (const k of ks) if (k.tokenId === tokenId) k.models = [...models];
    },
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
    runModels: () => [...ROLE_NAMES],
  };
  const audits: { action: string; subject: string; reason?: string; detail?: Record<string, unknown> }[] = [];
  const mio = (over: Partial<RoleKeyMigrationIo> = {}): RoleKeyMigrationIo => ({
    systems: async () => [{ id: 'sys_m', domain: 'sales', owner: 'u1', yaml: YAML }],
    deps: { keys: deps.keys, litellm: gw },
    sharedKey: SHARED_VALUE,
    log: () => undefined,
    audit: ((e: { action: string; subject: string }) => { audits.push(e); }) as never,
    ...over,
  });
  const rio = (): KeyReconcileIo => ({ systems: async () => [{ id: 'sys_m', domain: 'sales', owner: 'u1', yaml: YAML }], governYaml: async (y) => y, deps, autoCorrect: new Set<string>(), previous: null, log: () => undefined });
  /** A system key minted BEFORE the switch: built by the Build, then given the models the old build gave it. */
  const buildOld = async () => {
    await orchestrateBuild({ yaml: YAML, systemId: 'sys_m', adapters: makeLiveAdapters(deps).filter((a) => a.tool === 'litellm') });
    gw.rows.get('os-sys_m')![0].models = [...OLD];
    gw.updates.length = 0;
  };
  const addShared = (models: string[]) => gw.rows.set('sovereign-agents', [{ tokenId: tokenIdOf(SHARED_VALUE), models, maxBudget: 25, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1, maxParallelRequests: 8 }]);
  return { gw, deps, mio, rio, audits, buildOld, addShared };
}

const hasRoles = (m: string[]) => ROLE_NAMES.every((r) => m.includes(r));

test('a system key minted before the switch gets the three roles, keeps every model it had, and keeps its value', async () => {
  const t = setup(); await t.buildOld();
  const tokenBefore = t.gw.rows.get('os-sys_m')![0].tokenId;
  const r = await migrateRoleKeys(t.mio());
  assert.equal(r.ok, true, JSON.stringify(r));
  const k = t.gw.rows.get('os-sys_m')![0];
  assert.ok(hasRoles(k.models), k.models.join(','));
  for (const m of OLD) assert.ok(k.models.includes(m), `${m} was kept`);
  assert.equal(k.tokenId, tokenBefore, 'same key');
  assert.equal(t.gw.fullUpdates, 0, 'only the model list was written (no full key update)');
  assert.equal(t.gw.updates.length, 1);
});

test('the shared agent key gets the roles too (it is found by its value)', async () => {
  const t = setup(); t.addShared(['sovereign-default', 'os-admin-registered']);
  const r = await migrateRoleKeys(t.mio({ systems: async () => [] }));
  assert.equal(r.ok, true);
  const m = t.gw.rows.get('sovereign-agents')![0].models;
  assert.ok(hasRoles(m) && m.includes('sovereign-default') && m.includes('os-admin-registered'), m.join(','));
});

test('IDEMPOTENT: a second run writes nothing', async () => {
  const t = setup(); await t.buildOld(); t.addShared(['sovereign-default']);
  await migrateRoleKeys(t.mio());
  const writes = t.gw.updates.length;
  const again = await migrateRoleKeys(t.mio());
  assert.equal(t.gw.updates.length, writes);
  assert.deepEqual(again.changed, []);
});

test('DRY RUN reports the plan and writes nothing', async () => {
  const t = setup(); await t.buildOld(); t.addShared(['sovereign-default']);
  const r = await migrateRoleKeys(t.mio(), { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.changed.map((c) => c.subject).sort(), ['os-sys_m', 'shared agent key']);
  assert.ok(r.changed.every((c) => c.add.length === 3));
  assert.equal(t.gw.updates.length, 0);
  assert.equal(t.audits.length, 0, 'a dry run is not an audited change');
  assert.deepEqual(t.gw.rows.get('os-sys_m')![0].models, OLD);
});

test('every change is audited, naming the key and what was added', async () => {
  const t = setup(); await t.buildOld();
  await migrateRoleKeys(t.mio());
  const a = t.audits.filter((x) => x.action === 'gateway.key.reconcile');
  assert.equal(a.length, 1);
  assert.equal(a[0].subject, 'os-sys_m');
  assert.deepEqual((a[0].detail as { added: string[] }).added.sort(), [...ROLE_NAMES].sort());
});

test('NEGATIVE TWIN: a key the OS does not own is untouched — another token under an os-<id> alias, a key in no registry, an unrestricted key', async () => {
  const t = setup(); await t.buildOld();
  // someone else's key that happens to carry the alias an OS system would use
  t.gw.rows.set('os-sys_other', [{ tokenId: 'sha-someone-else', models: ['gpt-x'], maxBudget: 1, budgetDuration: '', rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1 }]);
  // an OS system whose stored key is not the one under its alias
  const foreign = t.gw.rows.get('os-sys_m')![0];
  const other = { ...foreign, tokenId: 'sha-not-the-stored-one', models: ['gpt-y'] };
  t.gw.rows.set('os-sys_m', [other]);
  // a key in the gateway no registry knows
  t.gw.rows.set('team-key', [{ tokenId: 'sha-team', models: ['gpt-z'], maxBudget: 1, budgetDuration: '', rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1 }]);
  // the shared key is unrestricted (empty list = every model): nothing to add
  t.addShared([]);
  const r = await migrateRoleKeys(t.mio({ systems: async () => [{ id: 'sys_m', domain: 'sales', owner: 'u1', yaml: YAML }, { id: 'sys_other', domain: 'sales', owner: 'u1', yaml: YAML }] }));
  assert.equal(t.gw.updates.length, 0, JSON.stringify(t.gw.updates));
  assert.deepEqual(t.gw.rows.get('os-sys_other')![0].models, ['gpt-x']);
  assert.deepEqual(t.gw.rows.get('os-sys_m')![0].models, ['gpt-y']);
  assert.deepEqual(t.gw.rows.get('team-key')![0].models, ['gpt-z']);
  assert.deepEqual(t.gw.rows.get('sovereign-agents')![0].models, []);
  assert.ok(r.skipped.some((s) => s.subject === 'os-sys_m' && /not the key the OS stored/.test(s.why)), JSON.stringify(r.skipped));
});

test('NEGATIVE TWIN: an unreachable gateway writes nothing and says so', async () => {
  const t = setup(); await t.buildOld(); t.gw.unreachable = true;
  const r = await migrateRoleKeys(t.mio());
  assert.equal(r.ok, false);
  assert.equal(t.gw.updates.length, 0);
  assert.ok(r.errors.length > 0);
});

test('NEGATIVE TWIN: an unreadable registry (not hydrated) does not touch system keys', async () => {
  const t = setup(); await t.buildOld();
  const r = await migrateRoleKeys(t.mio({ systems: async () => null }));
  assert.equal(r.ok, false);
  assert.equal(t.gw.updates.length, 0);
});

test('AFTER THE MIGRATION the key reconcile sees no drift (before it, it did)', async () => {
  const t = setup(); await t.buildOld();
  const before = await runKeyReconcile(t.rio());
  assert.equal(before.entries.length, 1, 'a pre-switch key lacks the roles: drift');
  assert.ok(before.entries[0].changes.some((c) => c.startsWith('models')), before.entries[0].changes.join('|'));
  await migrateRoleKeys(t.mio());
  const after = await runKeyReconcile(t.rio());
  assert.deepEqual(after.entries, [], JSON.stringify(after.entries));
  assert.equal(after.inSync, 1);
});

test('NEGATIVE TWIN: the reconcile still reports a model the definition needs that the key lacks, or a foreign model it holds', async () => {
  const t = setup(); await t.buildOld();
  await migrateRoleKeys(t.mio());
  const k = t.gw.rows.get('os-sys_m')![0];
  k.models = k.models.filter((m) => m !== 'sovereign-strong');
  assert.equal((await runKeyReconcile(t.rio())).entries.length, 1, 'a missing role is drift');
  k.models = [...ROLE_NAMES, 'gpt-foreign'];
  assert.equal((await runKeyReconcile(t.rio())).entries.length, 1, 'a foreign extra model is drift');
});
