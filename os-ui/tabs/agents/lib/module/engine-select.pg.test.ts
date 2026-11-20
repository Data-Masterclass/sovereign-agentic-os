/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53d — the resume engine is read from the run's stamp on real Postgres 17
 * USER STORY: As the operator I want a parked module run to resume on the module even after I turn
 *             AGENT_GRAPH_MODULE off, a v1 run to stay on v1, and a resume whose stamp cannot be
 *             read to FAIL — never to quietly start on the other engine.
 * ARCHITECTURE:
 *   - `isModuleRun` against its own database: before the migration (no table ⇒ no run was ever
 *     stamped ⇒ v1), after it (stamped ⇒ module, unstamped ⇒ v1), and against an unreachable
 *     server (throws). `engineForRun` with the flag OFF on top of the real lookup.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dropIsolated, isolateAgentRunsDatabase } from '@tabs/agents/lib/module/fixtures/pg-db';

await isolateAgentRunsDatabase('wp53d_engine');
const URL_ = (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
const skip = !URL_ ? 'AGENT_RUNS_TEST_DATABASE_URL not set — the WP-53d engine-selection tests did not run' : false;

const { isModuleRun } = await import('@tabs/agents/lib/module/os-run');
const { engineForRun } = await import('@tabs/agents/lib/module/flag');
const { postgresModuleRunStamps } = await import('@tabs/agents/lib/module/run');
const { migrateAgentRuns } = await import('@core/adapters/postgres/migrate');
const { agentRunsPool } = await import('@tabs/agents/lib/engine/pg-pool');

// `agentRunsPool` caches ONE pool per process (by URL): every pool this file opens is ended here.
const opened: { end: () => Promise<void> }[] = [];
after(async () => {
  for (const p of opened) await p.end().catch(() => {});
  await dropIsolated();
});

test('flag OFF: the resume follows the stamp on real Postgres — module stays module, v1 stays v1', { skip }, async () => {
  const resume = (runId: string) => engineForRun({ resume: true, domain: 'test', runId, isModuleRun: (id) => isModuleRun(id, URL_), enabled: false, domains: [] });
  // Before the migration no run can have been stamped: v1.
  opened.push(await agentRunsPool(URL_));
  assert.equal(await isModuleRun('run-a', URL_), false);
  const m = await migrateAgentRuns({ databaseUrl: URL_ });
  assert.equal(m.ok, true, JSON.stringify(m));
  await postgresModuleRunStamps(await agentRunsPool(URL_)).stamp('run-module', { systemId: 's', userId: 'u', domain: 'test', digest: 'd', commit: null });
  assert.equal(await resume('run-module'), 'module', 'a parked module run resumes on the module with the flag off');
  assert.equal(await resume('run-v1'), 'v1');
  // A new run with the flag off is v1, whatever its domain.
  assert.equal(await engineForRun({ resume: false, domain: 'test', runId: 'run-new', isModuleRun: (id) => isModuleRun(id, URL_), enabled: false, domains: ['test'] }), 'v1');
});

test('negative twin: a stamp that cannot be read fails the resume — it is never read as "v1"', { skip }, async () => {
  const u = new URL(URL_);
  u.port = '1';
  opened.push(await agentRunsPool(u.toString()));
  await assert.rejects(engineForRun({ resume: true, domain: 'test', runId: 'run-x', isModuleRun: (id) => isModuleRun(id, u.toString()), enabled: false, domains: [] }));
});
