/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Tests for the one-time, make-before-break key migration.
 * USER STORY: As a system owner, my un-rebuilt system keeps running across the upgrade. As a
 *             security reviewer, its old key answers 401 afterwards. As a platform admin, a
 *             crash at any step is finished by the next pass, with ONE new key, not two.
 * ARCHITECTURE:
 *   - The gateway fake models LiteLLM's two rules that matter here: aliases are unique (generate
 *     and rename refuse a taken alias), and inference authenticates the bearer by its SHA-256
 *     token id (a deleted key is a 401). After EVERY admin call the fake checks the invariant the
 *     migration exists for: the key the run path would use right now authenticates.
 *   - NEGATIVE TWIN: the same invariant check, run against the old delete-first order, fails.
 *   - The real-gateway proof of rename/register/401 is `system-key-migration.e2e.test.ts`
 *     (real LiteLLM image, scripts/tests/agent-key-migration/run.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRE_RANDOM_KEY_MIGRATION,
  __setSystemKeyJournalForTests,
  __setSystemKeyStoreForTests,
  deploymentKek,
  legacyDerivedKey,
  memorySystemKeyJournal,
  memorySystemKeyStore,
  resolveSystemKey,
  tokenIdOf,
  type SystemKeyJournal,
  type SystemKeyStore,
} from '@core/infra/agent-system-keys';
import type { LiteLlmClient, LiteLlmKeyInput, LiteLlmKeyState, LiveDeps } from '@tabs/agents/lib/build/live';
import { runKeyMigration, type KeyMigrationIo, type MigrationSystem } from '@tabs/agents/lib/build/system-key-migration';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: sovereign-default }
`;

type Crash = 'rename' | 'generate' | 'put' | 'delete' | 'clear' | null;

/** A LiteLLM-shaped gateway: unique aliases, bearer → SHA-256 token id. */
function gateway() {
  const byAlias = new Map<string, LiteLlmKeyState>();
  const state = (input: LiteLlmKeyInput, tokenId: string): LiteLlmKeyState => ({
    tokenId, models: [...input.models], maxBudget: input.maxBudget, budgetDuration: input.budgetDuration,
    rpmLimit: input.rpmLimit, tpmLimit: input.tpmLimit, maxParallelRequests: input.maxParallelRequests, allowedTools: [...input.allowedTools],
  });
  let afterEach: () => Promise<void> = async () => undefined;
  let crashAt: Crash = null;
  const crash = async (step: Crash) => { if (crashAt === step) { crashAt = null; throw new Error(`process killed during ${step}`); } };
  const admin: LiteLlmClient = {
    async keysByAlias(alias) { const k = byAlias.get(alias); return k ? [{ ...k }] : []; },
    async generateKey(input, key) {
      await crash('generate');
      if (byAlias.has(input.alias)) throw new Error(`LiteLLM /key/generate failed (400) — alias '${input.alias}' already exists`);
      byAlias.set(input.alias, state(input, tokenIdOf(key)));
      await afterEach();
    },
    async updateKey(tokenId, input) {
      for (const [a, k] of byAlias) if (k.tokenId === tokenId) byAlias.set(a, state(input, tokenId));
      await afterEach();
    },
    async renameKey(tokenId, alias) {
      await crash('rename');
      if (byAlias.has(alias)) throw new Error('LiteLLM /key/update failed (400) — alias taken');
      for (const [a, k] of [...byAlias]) if (k.tokenId === tokenId) { byAlias.delete(a); byAlias.set(alias, k); }
      await afterEach();
    },
    async deleteKey(tokenId) {
      await crash('delete');
      for (const [a, k] of [...byAlias]) if (k.tokenId === tokenId) byAlias.delete(a);
      await afterEach();
    },
    async models() { return []; },
  };
  /** Inference: 200 when the bearer is a key the gateway holds, else 401 (as LiteLLM answers). */
  const call = (bearer: string): number => ([...byAlias.values()].some((k) => k.tokenId === tokenIdOf(bearer)) ? 200 : 401);
  return {
    byAlias, admin, call,
    crashOn: (s: Crash) => { crashAt = s; },
    watch: (f: () => Promise<void>) => { afterEach = f; },
  };
}

function setup(systems: MigrationSystem[]) {
  const gw = gateway();
  const store: SystemKeyStore = memorySystemKeyStore();
  const journal: SystemKeyJournal = memorySystemKeyJournal();
  __setSystemKeyStoreForTests(store);
  __setSystemKeyJournalForTests(journal);
  const deps: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm: gw.admin,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    keys: { store, journal, kek: () => deploymentKek() },
  };
  const audits: { subject: string; reason: string; detail: Record<string, unknown> }[] = [];
  const io: KeyMigrationIo = {
    systems: async () => systems,
    governYaml: async (y) => y,
    deps,
    log: () => undefined,
    audit: ((e: { subject: string; reason: string; detail?: Record<string, unknown> }) => { audits.push({ subject: e.subject, reason: e.reason, detail: e.detail ?? {} }); }) as KeyMigrationIo['audit'],
  };
  return { gw, store, journal, deps, io, audits };
}

/** A system as an old deployment left it: the guessable key at the gateway, nothing stored. */
function withLegacy(gw: ReturnType<typeof gateway>, id: string) {
  const alias = `os-${id}`;
  const value = legacyDerivedKey(alias);
  gw.byAlias.set(alias, { tokenId: tokenIdOf(value), models: ['sovereign-default'], maxBudget: null as unknown as number, budgetDuration: '', rpmLimit: 0, tpmLimit: 0, maxParallelRequests: 0 });
  return value;
}

/** The key a run would present right now: the stored one, or — before the swap — the old one it still has. */
async function keyARunUses(store: SystemKeyStore, id: string, old: string): Promise<string> {
  return (await store.get(id)) ? (await resolveSystemKey(id, { fresh: true, awaitMigration: false })).key : old;
}

test('AN EXISTING SYSTEM KEEPS RUNNING: at every gateway step the key a run would use authenticates, and the run that waited gets the new key', async () => {
  const { gw, store, io, journal, audits } = setup([{ id: 'sys_a', domain: 'sales', owner: 'u1', yaml: YAML }]);
  const old = withLegacy(gw, 'sys_a');
  const statuses: number[] = [];
  gw.watch(async () => { statuses.push(gw.call(await keyARunUses(store, 'sys_a', old))); });

  // A worker run starts before the migration has stored anything: it WAITS, it does not fail.
  const waiting = resolveSystemKey('sys_a', { fresh: true, awaitMigration: true, pollMs: 1, migrationWaitMs: 5_000, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  const result = await runKeyMigration(io);
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.equal(result.done, true);
  assert.deepEqual(result.migrated, ['os-sys_a']);
  assert.ok(statuses.length >= 3, 'rename, register and delete were all observed');
  assert.deepEqual(statuses.filter((s) => s !== 200), [], 'never a moment in which the run had no working key');

  const got = await waiting;
  assert.equal(gw.call(got.key), 200, 'the run that waited now calls with its own key');
  assert.notEqual(got.key, old);
  assert.equal(await journal.migrationDone(PRE_RANDOM_KEY_MIGRATION), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].subject, 'os-sys_a');
  assert.equal(audits[0].detail.outcome, 'migrated');
  assert.ok(!JSON.stringify(audits).includes(tokenIdOf(old)) && !JSON.stringify(audits).includes('sk-'), 'no key or token id in the audit');
});

test('THE OLD KEY IS DEAD AFTERWARDS: the guessable value gets 401, the new key is budgeted, and a second pass changes nothing', async () => {
  const { gw, store, io } = setup([{ id: 'sys_a', domain: 'sales', owner: 'u1', yaml: YAML }]);
  const old = withLegacy(gw, 'sys_a');
  assert.equal(gw.call(old), 200, 'precondition: the guessable key works before the migration');
  await runKeyMigration(io);
  assert.equal(gw.call(old), 401);
  const key = gw.byAlias.get('os-sys_a')!;
  assert.ok(key.maxBudget > 0, 'the new key carries a budget');
  assert.equal(gw.byAlias.size, 1, 'no retiring key is left behind');
  const value = (await resolveSystemKey('sys_a', { fresh: true })).key;
  const again = await runKeyMigration(io);
  assert.deepEqual([again.migrated, again.alreadyFine], [[], 1], 'idempotent');
  assert.equal((await resolveSystemKey('sys_a', { fresh: true })).key, value, 'the second pass did not mint again');
  void store;
});

for (const step of ['rename', 'generate', 'put', 'delete', 'clear'] as const) {
  test(`A CRASH DURING '${step}' IS SAFE: the system keeps a working key, and the re-run finishes with ONE new value`, async () => {
    const { gw, store, journal, io, deps } = setup([{ id: 'sys_a', domain: 'sales', owner: 'u1', yaml: YAML }]);
    const old = withLegacy(gw, 'sys_a');
    if (step === 'put') {
      const put = store.put.bind(store);
      let once = true;
      deps.keys.store = { ...store, put: async (r) => { if (once) { once = false; throw new Error('process killed during put'); } return put(r); } };
    } else if (step === 'clear') {
      const clear = journal.clear.bind(journal);
      let once = true;
      deps.keys.journal = { ...journal, clear: async (id) => { if (once) { once = false; throw new Error('process killed during clear'); } return clear(id); } };
    } else {
      gw.crashOn(step);
    }
    const first = await runKeyMigration(io);
    assert.equal(first.ok, false, 'the crashed pass reports a failure');
    assert.equal(first.done, false, 'and does not mark the migration done');
    const usable = await keyARunUses(deps.keys.store, 'sys_a', old);
    assert.equal(gw.call(usable), 200, `after a crash during ${step} the system still has a working key`);

    const second = await runKeyMigration(io);
    assert.equal(second.ok, true, JSON.stringify(second.failed));
    assert.equal(second.done, true);
    assert.equal(gw.call(old), 401, 'the old key is gone after the re-run');
    assert.equal(gw.byAlias.size, 1, 'exactly one key for the system');
    const now = (await resolveSystemKey('sys_a', { fresh: true, awaitMigration: false })).key;
    assert.equal(gw.call(now), 200);
    assert.equal(gw.byAlias.get('os-sys_a')!.tokenId, tokenIdOf(now), 'the stored value is the one registered');
    assert.equal(await deps.keys.journal.staged('sys_a'), null, 'the journal is closed');
  });
}

test('AN UNREADABLE REGISTRY migrates nothing and marks nothing done — so runs keep waiting rather than being told "no key"', async () => {
  const { gw, io, journal } = setup([]);
  withLegacy(gw, 'sys_a');
  const out = await runKeyMigration({ ...io, systems: async () => null });
  assert.equal(out.ok, false);
  assert.equal(out.done, false);
  assert.equal(await journal.migrationDone(PRE_RANDOM_KEY_MIGRATION), false);
  assert.equal(gw.byAlias.size, 1, 'the old key was not touched');
});

test('A SYSTEM THAT CANNOT BE MOVED is audited as failed, keeps its old key, and the migration stays open; the others are moved', async () => {
  const { gw, io, journal, audits } = setup([
    { id: 'sys_bad', domain: 'sales', owner: 'u1', yaml: 'not: [a, valid system' },
    { id: 'sys_ok', domain: 'sales', owner: 'u1', yaml: YAML },
  ]);
  const badOld = withLegacy(gw, 'sys_bad');
  withLegacy(gw, 'sys_ok');
  const out = await runKeyMigration(io);
  assert.deepEqual(out.migrated, ['os-sys_ok']);
  assert.deepEqual(out.failed.map((f) => f.alias), ['os-sys_bad']);
  assert.equal(out.done, false);
  assert.equal(await journal.migrationDone(PRE_RANDOM_KEY_MIGRATION), false);
  assert.equal(gw.call(badOld), 200, 'its old key is not deleted: it was never replaced');
  assert.deepEqual(audits.map((a) => [a.subject, a.detail.outcome]), [['os-sys_bad', 'failed'], ['os-sys_ok', 'migrated']]);
});

test('NEGATIVE TWIN: the old delete-first order DOES leave a moment with no working key — the invariant check catches it', async () => {
  const gw = gateway();
  const old = withLegacy(gw, 'sys_a');
  const store = memorySystemKeyStore();
  const statuses: number[] = [];
  gw.watch(async () => { statuses.push(gw.call(await keyARunUses(store, 'sys_a', old))); });
  __setSystemKeyStoreForTests(store);
  __setSystemKeyJournalForTests(memorySystemKeyJournal());
  // What Build did before: delete the old key, then register the new one, then store it.
  await gw.admin.deleteKey(tokenIdOf(old));
  await gw.admin.generateKey({ systemId: 'sys_a', alias: 'os-sys_a', models: [], maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1, allowedTools: [] }, 'sk-new-value-for-the-twin');
  assert.ok(statuses.includes(401), 'the delete-first order is observed failing a run');
});

test('A RUN WITH NO KEY after the migration completed is told to press Build — after the wait, never on another key', async () => {
  const { journal } = setup([]);
  await journal.markMigrationDone(PRE_RANDOM_KEY_MIGRATION, 1);
  await assert.rejects(resolveSystemKey('sys_never', { fresh: true, awaitMigration: true, pollMs: 1, migrationWaitMs: 50 }), (e: Error) => /press Build/.test(e.message));
});
