/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The make-before-break key migration, proven against the REAL LiteLLM image.
 * USER STORY: As the owner I need proof from the real gateway, not a fake, that an existing
 *             system keeps a working key throughout its migration, that its old guessable key is
 *             refused afterwards, and that a pass killed half-way is finished by the next one.
 * ARCHITECTURE:
 *   - Runs ONLY against the containers started by scripts/tests/agent-key-migration/run.sh (the
 *     chart's LiteLLM image, postgres:17). Without them the suite SKIPS, saying so; with
 *     AGENT_KEY_MIGRATION_E2E_REQUIRED=1 a missing gateway is a FAILURE.
 *   - Admin calls go through os-ui's real client (`realLitellm`: /key/list, /key/generate with a
 *     caller-supplied key, /key/update with key_alias, /key/update with duration = LiteLLM's own key
 *     expiry for the old key's grace period, /key/delete by the sweep once it has expired). "Does this key work" is the
 *     gateway's own inference auth: GET /v1/models with the key as bearer (200 or 401).
 *   - The store and journal are the in-memory implementations (the Postgres ones are proven in
 *     system-key-migration.pg.test.ts); what this file proves is the gateway side.
 *   - NEGATIVE TWIN: a key the gateway never issued must be 401 — the auth check is not faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  __setSystemKeyJournalForTests,
  __setSystemKeyStoreForTests,
  deriveKek,
  legacyDerivedKey,
  memorySystemKeyJournal,
  memorySystemKeyStore,
  openSystemKey,
  tokenIdOf,
  type SystemKeyStore,
} from '@core/infra/agent-system-keys';
import { realLitellm } from '@tabs/agents/lib/build/live-clients';
import type { LiteLlmClient, LiveDeps } from '@tabs/agents/lib/build/live';
import { runKeyMigration, type KeyMigrationIo } from '@tabs/agents/lib/build/system-key-migration';

const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const MASTER = process.env.LITELLM_MASTER_KEY ?? '';
const REQUIRED = process.env.AGENT_KEY_MIGRATION_E2E_REQUIRED === '1';
if (REQUIRED && (!GW || !MASTER)) throw new Error('AGENT_KEY_MIGRATION_E2E_REQUIRED=1 but LITELLM_URL / LITELLM_MASTER_KEY are not set');
const skip = GW && MASTER && REQUIRED ? false : 'run scripts/tests/agent-key-migration/run.sh (needs the real LiteLLM image)';

const KEK = deriveKek('e2e-key-encryption-secret-0123456789abcdef');
const GRACE_S = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sweep against the real gateway: what removes a retiring key once LiteLLM has expired it. */
async function sweepExpired(id: string) {
  const { runKeySweep } = await import('@core/infra/agent-system-key-sweep');
  const { readAllKeys } = await import('@core/infra/litellm-admin');
  const { adminPost } = await import('@core/infra/litellm-write');
  return runKeySweep({ keep: new Set([`os-${id}`]), list: () => readAllKeys(), deleteKey: (t) => adminPost('/key/delete', { keys: [t] }, 8000), log: () => undefined });
}
const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: sovereign-default }
`;

/** The gateway's own answer to "may this key call?" */
async function auth(key: string): Promise<number> {
  const res = await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  return res.status;
}

/** Register a system's key the way releases before this change did: value `sk-os-<id>`. */
async function registerLegacy(id: string): Promise<string> {
  const value = legacyDerivedKey(`os-${id}`);
  const res = await fetch(`${GW}/key/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: value, key_alias: `os-${id}`, models: ['sovereign-default'] }),
  });
  assert.equal(res.status, 200, `could not register the legacy key: ${await res.text()}`);
  return value;
}

/** Every key the gateway holds whose alias starts with `os-<id>` (the system's key and any retiring one). */
async function keysOf(id: string): Promise<{ alias: string; token: string }[]> {
  const res = await fetch(`${GW}/key/list?return_full_object=true&size=100`, { headers: { authorization: `Bearer ${MASTER}` } });
  const body = (await res.json()) as { keys?: { key_alias?: string; token?: string }[] };
  return (body.keys ?? [])
    .filter((k) => typeof k.key_alias === 'string' && (k.key_alias === `os-${id}` || k.key_alias.startsWith(`os-${id}.retiring.`)))
    .map((k) => ({ alias: String(k.key_alias), token: String(k.token) }));
}

function wire(id: string, litellm: LiteLlmClient) {
  const store: SystemKeyStore = memorySystemKeyStore();
  const journal = memorySystemKeyJournal();
  __setSystemKeyStoreForTests(store);
  __setSystemKeyJournalForTests(journal);
  const deps: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    // A short grace so the test can watch LiteLLM's own expiry refuse the old key.
    keys: { store, journal, kek: () => KEK, retireGraceSeconds: GRACE_S },
    caps: { maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 },
    runModels: () => ['sovereign-default'],
  };
  const io: KeyMigrationIo = {
    systems: async () => [{ id, domain: 'sales', owner: 'u1', yaml: YAML }],
    governYaml: async (y) => y,
    deps,
    log: () => undefined,
    audit: (() => undefined) as never,
  };
  return { store, journal, deps, io };
}

test('NEGATIVE TWIN: a key the gateway never issued is refused (401) — the auth check is real', { skip }, async () => {
  assert.equal(await auth(`sk-${randomBytes(24).toString('base64url')}`), 401);
});

test('REAL GATEWAY: the system keeps a working key at every step; afterwards the old key is 401, the new one 200; a re-run is a no-op', { skip }, async () => {
  const id = `e2e_${randomBytes(4).toString('hex')}`;
  const old = await registerLegacy(id);
  assert.equal(await auth(old), 200, 'precondition: the legacy key works');

  // Wrap the REAL client: after every admin call, ask the gateway whether the key a run would use
  // right now (stored → new; not yet stored → old) authenticates.
  const real = realLitellm();
  const { store, io } = wire(id, real);
  const seen: string[] = [];
  const check = async (step: string) => {
    const rec = await store.get(id);
    const key = rec ? openSystemKey(rec, KEK) : old;
    seen.push(`${step}:${await auth(key)}`);
  };
  io.deps.litellm = {
    ...real,
    generateKey: async (i, k) => { await real.generateKey(i, k); await check('generate'); },
    renameKey: async (t, a) => { await real.renameKey(t, a); await check('rename'); },
    deleteKey: async (t) => { await real.deleteKey(t); await check('delete'); },
    expireKey: async (t, sec) => { await real.expireKey(t, sec); await check('expire'); },
  };

  const out = await runKeyMigration(io);
  assert.equal(out.ok, true, JSON.stringify(out.failed));
  assert.ok(seen.some((s) => s.startsWith('rename')) && seen.some((s) => s.startsWith('generate')) && seen.some((s) => s.startsWith('expire')), seen.join(' '));
  assert.deepEqual(seen.filter((s) => !s.endsWith(':200')), [], `a run had no working key at: ${seen.join(' ')}`);

  const rec = (await store.get(id))!;
  const fresh = openSystemKey(rec, KEK);
  assert.equal(await auth(old), 200, 'during the grace period a run still holding the old value keeps working');
  assert.equal(await auth(fresh), 200, 'the new key works');
  await sleep(GRACE_S * 1000 + 2500);
  assert.equal(await auth(old), 401, 'after the grace period the real gateway refuses the old key (LiteLLM key expiry)');
  const swept = await sweepExpired(id);
  assert.equal(swept.ok, true, JSON.stringify(swept));
  const left = await keysOf(id);
  assert.deepEqual(left.map((k) => k.alias), [`os-${id}`], 'one key for the system, no retiring key left behind');
  assert.equal(left[0].token, tokenIdOf(fresh));

  const again = await runKeyMigration(io);
  assert.deepEqual([again.migrated, again.alreadyFine], [[], 1]);
  assert.equal(openSystemKey((await store.get(id))!, KEK), fresh, 'no second value was minted');
});

test('REAL GATEWAY: a pass killed right after moving the old key aside is finished by the next pass, with ONE new value', { skip }, async () => {
  const id = `e2e_${randomBytes(4).toString('hex')}`;
  const old = await registerLegacy(id);
  const real = realLitellm();
  const { store, journal, io } = wire(id, real);
  let killed = false;
  io.deps.litellm = { ...real, generateKey: async (i, k) => { if (!killed) { killed = true; throw new Error('os-ui killed before /key/generate'); } return real.generateKey(i, k); } };

  const dead = await runKeyMigration(io);
  assert.equal(dead.ok, false);
  assert.equal(await auth(old), 200, 'after the crash the old key still works (moved aside, not deleted)');
  const midway = await keysOf(id);
  assert.deepEqual(midway.map((k) => k.alias), [`os-${id}.retiring.${tokenIdOf(old).slice(0, 12)}`], 'the real gateway accepted the alias change');
  const staged = (await journal.staged(id))!;
  assert.ok(staged);

  const done = await runKeyMigration(io);
  assert.equal(done.ok, true, JSON.stringify(done.failed));
  const fresh = openSystemKey((await store.get(id))!, KEK);
  assert.equal(tokenIdOf(fresh), staged.record.tokenId, 'the staged value, not a second one');
  assert.equal(await auth(fresh), 200);
  await sleep(GRACE_S * 1000 + 2500);
  assert.equal(await auth(old), 401);
  await sweepExpired(id);
  assert.deepEqual((await keysOf(id)).map((k) => k.alias), [`os-${id}`]);
});
