/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-26 — a worker killed between two tool calls resumes from the Postgres checkpoint
 * USER STORY: As an operator I want a worker that dies mid-run (OOM, node drain) to lose nothing
 *             and repeat nothing: the call that completed before the death is not executed again
 *             when another worker picks the run up.
 * ARCHITECTURE:
 *   - The worker is a real OS process (`hitl.pg-fixture.ts`) that `process.exit(137)`s the moment
 *     the SECOND read is dispatched — after the first call's superstep was checkpointed by the
 *     real `PostgresSaver`. A new process resumes the thread. The side-effect table proves the
 *     first call ran exactly once across the death.
 *   - Needs `AGENT_RUNS_TEST_DATABASE_URL`; see `hitl.pg.test.ts` for the skip / REQUIRE rule.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { prepareFixtureTables, step, testDatabaseUrl } from '@tabs/agents/lib/engine/hitl.pg-fixture';

const URL_ = testDatabaseUrl();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
const skip = URL_ ? false : 'AGENT_RUNS_TEST_DATABASE_URL not set — the real-Postgres durability test did not run';

let pool: pg.Pool;
before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 2 });
  await prepareFixtureTables(pool);
});
after(async () => { await pool?.end(); });

test('a worker killed between two tool calls: the resumed run does not re-execute the completed call', { skip }, async () => {
  const runId = `wp26-crash-${process.pid}-${Date.now()}`;
  const dead = step({ step: 'start', runId, batch: 'reads', crashOn: 'query_data' });
  assert.equal(dead.exitCode, 137, 'the worker process really died');
  const before1 = await pool.query(`SELECT tool FROM wp26_side_effects WHERE run_id = $1 ORDER BY id`, [runId]);
  assert.deepEqual(before1.rows.map((r) => r.tool), ['search_knowledge'], 'the first call completed before the death');

  const resumed = step({ step: 'replay', runId, batch: 'reads' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  assert.equal(resumed.reachedEnd, true);
  const after1 = await pool.query(`SELECT tool FROM wp26_side_effects WHERE run_id = $1 ORDER BY id`, [runId]);
  assert.deepEqual(after1.rows.map((r) => r.tool), ['search_knowledge', 'query_data'], 'search_knowledge exactly once across the death');
});
