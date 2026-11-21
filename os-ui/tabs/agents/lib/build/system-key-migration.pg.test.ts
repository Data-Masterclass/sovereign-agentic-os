/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The key migration's journal and store on REAL Postgres 17, across a process restart.
 * USER STORY: As a platform admin, if os-ui dies half-way through moving a system onto its new
 *             key, the next os-ui finishes the move from what is in the database — with the same
 *             value, not a second one — and the worker sees the migration as done.
 * ARCHITECTURE:
 *   - Real `agent_system_keys`, `agent_system_key_staging` and `agent_system_key_migrations`
 *     tables (the module's own DDL) on the CI postgres:17 service; each "process" is a NEW pool
 *     and new store/journal objects, nothing shared in memory.
 *   - The gateway is a LiteLLM-shaped fake (unique aliases; the real-image proof is the e2e).
 *   - Needs `AGENT_RUNS_TEST_DATABASE_URL`; skips without it, fails under REQUIRE_PG_TESTS=1.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { dropIsolated, isolateAgentRunsDatabase } from '@tabs/agents/lib/module/fixtures/pg-db';
import {
  PRE_RANDOM_KEY_MIGRATION,
  SYSTEM_KEY_JOURNAL_DDL,
  deriveKek,
  legacyDerivedKey,
  migrateSystemKeys,
  openSystemKey,
  postgresSystemKeyJournal,
  postgresSystemKeyStore,
  tokenIdOf,
  type SqlClient,
} from '@core/infra/agent-system-keys';
import type { LiteLlmClient, LiteLlmKeyState, LiveDeps } from '@tabs/agents/lib/build/live';
import { runKeyMigration } from '@tabs/agents/lib/build/system-key-migration';

await isolateAgentRunsDatabase('key_migration');
const URL_ = (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
const skip = URL_ ? false : 'AGENT_RUNS_TEST_DATABASE_URL not set — the real-Postgres key-migration test did not run';

const KEK = deriveKek('pg-test-key-encryption-secret-0123456789abcdef');
const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: sovereign-default }
`;

const pools: pg.Pool[] = [];
async function process_(): Promise<{ sql: SqlClient }> {
  const pool = new pg.Pool({ connectionString: URL_, max: 2 });
  pools.push(pool);
  await migrateSystemKeys(pool as unknown as SqlClient);
  for (const stmt of SYSTEM_KEY_JOURNAL_DDL) await pool.query(stmt);
  return { sql: pool as unknown as SqlClient };
}
before(async () => { if (!skip) await process_(); });
after(async () => { for (const p of pools) await p.end(); await dropIsolated(); });

function gateway(crashOnGenerate: { once: boolean }) {
  const byAlias = new Map<string, LiteLlmKeyState>();
  const expiring = new Set<string>();
  const admin: LiteLlmClient = {
    async keysByAlias(alias) { const k = byAlias.get(alias); return k ? [{ ...k }] : []; },
    async generateKey(input, key) {
      if (crashOnGenerate.once) { crashOnGenerate.once = false; throw new Error('os-ui killed during /key/generate'); }
      if (byAlias.has(input.alias)) throw new Error('alias taken');
      byAlias.set(input.alias, { tokenId: tokenIdOf(key), models: [...input.models], maxBudget: input.maxBudget, budgetDuration: input.budgetDuration, rpmLimit: input.rpmLimit, tpmLimit: input.tpmLimit, maxParallelRequests: input.maxParallelRequests, allowedTools: [...input.allowedTools] });
    },
    async updateKey() { /* not reached: the system starts with no stored key */ },
    async renameKey(tokenId, alias) {
      if (byAlias.has(alias)) throw new Error('alias taken');
      for (const [a, k] of [...byAlias]) if (k.tokenId === tokenId) { byAlias.delete(a); byAlias.set(alias, k); }
    },
    async deleteKey(tokenId) { for (const [a, k] of [...byAlias]) if (k.tokenId === tokenId) byAlias.delete(a); },
    async expireKey(tokenId) { expiring.add(tokenId); },
    async models() { return []; },
  };
  return { byAlias, admin, expiring };
}

function deps(sql: SqlClient, litellm: LiteLlmClient): LiveDeps {
  return {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    keys: { store: postgresSystemKeyStore(sql), journal: postgresSystemKeyJournal(sql), kek: () => KEK },
  };
}

test('a crash after STAGE is finished by the NEXT process from Postgres, with the same value; the worker then sees the migration done', { skip }, async () => {
  const crash = { once: true };
  const gw = gateway(crash);
  const old = legacyDerivedKey('os-sys_pg');
  gw.byAlias.set('os-sys_pg', { tokenId: tokenIdOf(old), models: [], maxBudget: 0, budgetDuration: '', rpmLimit: 0, tpmLimit: 0, maxParallelRequests: 0 });
  const systems = async () => [{ id: 'sys_pg', domain: 'sales', owner: 'u1', yaml: YAML }];

  const first = await process_();
  const dead = await runKeyMigration({ systems, governYaml: async (y) => y, deps: deps(first.sql, gw.admin), log: () => undefined, audit: (() => undefined) as never });
  assert.equal(dead.ok, false);
  const staged = await postgresSystemKeyJournal(first.sql).staged('sys_pg');
  assert.ok(staged, 'the staged value is in Postgres');
  assert.ok([...gw.byAlias.values()].some((k) => k.tokenId === tokenIdOf(old)), 'the old key still works (moved aside, not deleted)');
  assert.equal(await postgresSystemKeyStore(first.sql).get('sys_pg'), null, 'nothing a run reads changed yet');

  const second = await process_(); // a new os-ui: new pool, nothing in memory
  const done = await runKeyMigration({ systems, governYaml: async (y) => y, deps: deps(second.sql, gw.admin), log: () => undefined, audit: (() => undefined) as never });
  assert.equal(done.ok, true, JSON.stringify(done.failed));
  const record = (await postgresSystemKeyStore(second.sql).get('sys_pg'))!;
  assert.equal(record.tokenId, staged!.record.tokenId, 'the second process used the value the first one staged');
  assert.equal(gw.byAlias.get('os-sys_pg')!.tokenId, tokenIdOf(openSystemKey(record, KEK)));
  assert.ok(gw.expiring.has(tokenIdOf(old)), 'the old key was given its expiry (grace period), after the new one was stored');
  assert.equal(await postgresSystemKeyJournal(second.sql).staged('sys_pg'), null);

  const worker = await process_();
  assert.equal(await postgresSystemKeyJournal(worker.sql).migrationDone(PRE_RANDOM_KEY_MIGRATION), true, 'the worker reads the done marker');
});
