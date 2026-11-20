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
import { dropIsolated, isolateAgentRunsDatabase } from '@tabs/agents/lib/module/fixtures/pg-db';

// Parallel-safe: this file gets its own database (fixtures/pg-db.ts) before it reads the URL.
await isolateAgentRunsDatabase('wp26_durability');
const URL_ = testDatabaseUrl();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
const skip = URL_ ? false : 'AGENT_RUNS_TEST_DATABASE_URL not set — the real-Postgres durability test did not run';

let pool: pg.Pool;
before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 2 });
  await prepareFixtureTables(pool);
});
after(async () => { await pool?.end(); await dropIsolated(); });

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

// --- WP-26 verifier break tests: a worker death INSIDE the tool-call superstep ----------------
// LangGraph records a superstep's writes only after the step returns, so a death after the
// governed write committed replays the step. The tool-call ledger (`tool-call-ledger.ts`) in
// front of the governed executor makes the replay answer from the record, or refuse to re-send.

async function effects(runId: string): Promise<string[]> {
  return (await pool.query(`SELECT tool FROM wp26_side_effects WHERE run_id = $1 ORDER BY id`, [runId])).rows.map((r) => r.tool as string);
}

async function parkAndApprove(runId: string, crash: { crashAfter?: string; crashAfterRecorded?: string }) {
  const s1 = step({ step: 'start', runId, batch: 'held' });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const interruptId = s1.pendingInterruptIds![0];
  const { rows } = await pool.query(`SELECT approval_id FROM wp26_cards WHERE run_id = $1`, [runId]);
  const dead = step({ step: 'resume', runId, batch: 'held', resume: { interruptId, approvalId: rows[0].approval_id as string, decision: 'approve' }, ...crash });
  assert.equal(dead.exitCode, 137, 'the worker really died mid-step');
}

test('worker dies AFTER the approved write committed, before anything recorded it: the replay does NOT send the write again', { skip }, async () => {
  const runId = `wp26-ca-${process.pid}-${Date.now()}`;
  await parkAndApprove(runId, { crashAfter: 'request_promotion' });
  assert.deepEqual(await effects(runId), ['search_knowledge', 'request_promotion']);
  const r = step({ step: 'replay', runId, batch: 'held' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.reachedEnd, true);
  assert.deepEqual(await effects(runId), ['search_knowledge', 'request_promotion'], 'the approved write was dispatched ONCE across the death');
  const answer = JSON.parse(r.toolResults?.request_promotion ?? '{}') as { error?: { code?: string } };
  assert.equal(answer.error?.code, 'unresolved_previous_call', 'the agent is told the outcome is unverified, not that it failed or succeeded');
});

test('worker dies after the write\'s result was recorded, before the checkpoint: the replay answers from the record', { skip }, async () => {
  const runId = `wp26-cr-${process.pid}-${Date.now()}`;
  await parkAndApprove(runId, { crashAfterRecorded: 'request_promotion' });
  const r = step({ step: 'replay', runId, batch: 'held' });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.error));
  assert.deepEqual(await effects(runId), ['search_knowledge', 'request_promotion'], 'exactly once');
  assert.match(r.toolResults?.request_promotion ?? '', /"ran":"request_promotion"/, 'the recorded result, not an error');
});

test('a READ cut off by a worker death is sent again (at least once — re-reading is free)', { skip }, async () => {
  const runId = `wp26-rd-${process.pid}-${Date.now()}`;
  const dead = step({ step: 'start', runId, batch: 'reads', crashAfter: 'search_knowledge' });
  assert.equal(dead.exitCode, 137);
  const r = step({ step: 'replay', runId, batch: 'reads' });
  assert.equal(r.reachedEnd, true, JSON.stringify(r.error));
  assert.deepEqual(await effects(runId), ['search_knowledge', 'search_knowledge', 'query_data']);
});
