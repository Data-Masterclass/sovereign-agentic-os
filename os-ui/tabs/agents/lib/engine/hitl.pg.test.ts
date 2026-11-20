/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-26 — a held write pauses on LangGraph's own interrupt, survives a worker restart
 *             and resumes by INTERRUPT ID, against the real PostgresSaver on a real Postgres
 * USER STORY: As an approver I want a held agent write to wait for me across worker restarts, to
 *             show up as ONE card however often the worker replays it, to run EXACTLY ONCE when I
 *             approve, never when I reject — even if the hold policy changed while it waited — and
 *             to refuse a decision that names an interrupt the run is not waiting on.
 * ARCHITECTURE:
 *   - Every step runs in a NEW OS PROCESS (`hitl.pg-fixture.ts`): a new `pg.Pool`, a new
 *     `PostgresSaver`, a newly compiled graph. Between steps only Postgres holds state, so a
 *     "worker restart" is real. LangGraph (`@langchain/langgraph`), the checkpointer
 *     (`@langchain/langgraph-checkpoint-postgres`) and `pg` are the real libraries.
 *   - The side effect is a row per executed governed call in `wp26_side_effects`; the card queue
 *     is `wp26_cards`, UNIQUE on `<thread>:<interruptId>`.
 *   - Needs `AGENT_RUNS_TEST_DATABASE_URL` (CI: the `postgres:17` service of the
 *     `test-langgraph-pg` job). Without it the tests are SKIPPED, loudly — and
 *     `REQUIRE_PG_TESTS=1` (set in that job) turns a missing database into a failure.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { inventoryParked } from '@tabs/agents/lib/engine/parked-inventory';
import { prepareFixtureTables, step, testDatabaseUrl } from '@tabs/agents/lib/engine/hitl.pg-fixture';
import { dropIsolated, isolateAgentRunsDatabase } from '@tabs/agents/lib/module/fixtures/pg-db';

// Parallel-safe: this file gets its own database (fixtures/pg-db.ts) before it reads the URL.
await isolateAgentRunsDatabase('wp26_hitl');
const URL_ = testDatabaseUrl();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
const skip = URL_ ? false : 'AGENT_RUNS_TEST_DATABASE_URL not set — the real-Postgres HITL tests did not run';

let pool: pg.Pool;
const run = (name: string) => `wp26-${name}-${process.pid}-${Date.now()}`;

async function effects(runId: string): Promise<{ tool: string; actor: string }[]> {
  const { rows } = await pool.query(`SELECT tool, actor FROM wp26_side_effects WHERE run_id = $1 ORDER BY id`, [runId]);
  return rows as { tool: string; actor: string }[];
}
async function cards(runId: string): Promise<{ interrupt_key: string; approval_id: string; approver_role: string }[]> {
  const { rows } = await pool.query(`SELECT interrupt_key, approval_id, approver_role FROM wp26_cards WHERE run_id = $1`, [runId]);
  return rows as { interrupt_key: string; approval_id: string; approver_role: string }[];
}
async function checkpointRows(runId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM checkpoints WHERE thread_id = $1`, [runId]);
  return rows[0].n as number;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 2 });
  await prepareFixtureTables(pool);
});
after(async () => { await pool?.end(); await dropIsolated(); });

test('pause → worker restart → resume by interrupt id: ONE card, and the write runs EXACTLY ONCE as the runner', { skip }, async () => {
  const runId = run('approve');
  // 1. A worker starts the run: the held write parks on LangGraph's interrupt. Nothing ran.
  const s1 = step({ step: 'start', runId, batch: 'held' });
  assert.equal(s1.ok, true, JSON.stringify(s1.error));
  assert.equal(s1.parked, true);
  assert.equal(s1.pendingInterruptIds?.length, 1, 'exactly one interrupt per held call');
  const interruptId = s1.pendingInterruptIds![0];
  assert.match(interruptId, /^[0-9a-f]{16,}$/, 'a LangGraph interrupt id, not a call or approval id');
  assert.deepEqual(s1.heldApprovals?.map((h) => [h.interruptId, h.tool]), [[interruptId, 'request_promotion']]);
  assert.deepEqual(await effects(runId), [], 'nothing executed while parked');
  const c1 = await cards(runId);
  assert.equal(c1.length, 1);
  assert.equal(c1[0].interrupt_key, `${runId}:${interruptId}`, 'the card is keyed <thread>:<interruptId>');
  assert.equal(c1[0].approver_role, 'domain_admin');
  const approvalId = c1[0].approval_id;
  assert.equal(s1.heldApprovals![0].approvalId, approvalId);
  const rowsParked = await checkpointRows(runId);
  // The read-only parked-run inventory sees it as waiting on a CURRENT interrupt.
  assert.deepEqual(await inventoryParked(new PostgresSaver(pool), [runId]), [{ runId, kind: 'current', interrupts: 1, batchCalls: 2 }]);

  // 2. The worker dies and a NEW one replays the parked job without a decision (the reaper path).
  //    LangGraph re-runs the paused node from its start; the interrupt id is stable, so the card
  //    is not filed twice and nothing executes.
  const s2 = step({ step: 'replay', runId, batch: 'held' });
  assert.equal(s2.ok, true, JSON.stringify(s2.error));
  assert.equal(s2.parked, true);
  assert.deepEqual(s2.pendingInterruptIds, [interruptId], 'the same interrupt after a restart');
  assert.equal((await cards(runId)).length, 1, 'one card per held call after a forced worker restart');
  assert.deepEqual(await effects(runId), []);

  // 3. A third process resumes with the decision, keyed by the interrupt id.
  const s3 = step({ step: 'resume', runId, batch: 'held', resume: { interruptId, approvalId, decision: 'approve' } });
  assert.equal(s3.ok, true, JSON.stringify(s3.error));
  assert.equal(s3.parked, false);
  assert.equal(s3.reachedEnd, true);
  const ran = await effects(runId);
  assert.deepEqual(ran.map((e) => e.tool), ['search_knowledge', 'request_promotion'], 'each call exactly once across three processes');
  for (const e of ran) assert.equal(e.actor, FIXTURE_USER.id, 'executed as the runner, never the approver');
  assert.ok((await checkpointRows(runId)) > rowsParked, 'the resume wrote new checkpoints');

  // 4. The same decision delivered again (a duplicate) is refused, and changes nothing.
  const s4 = step({ step: 'resume', runId, batch: 'held', resume: { interruptId, approvalId, decision: 'approve' } });
  assert.equal(s4.ok, false);
  assert.equal(s4.error?.status, 409);
  assert.equal((await effects(runId)).length, 2, 'a duplicate resume never re-runs the write');
});

test('negative twin: a resume naming the WRONG interrupt id is refused with 409 and runs nothing', { skip }, async () => {
  const runId = run('wrong-id');
  const s1 = step({ step: 'start', runId, batch: 'held' });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const [card] = await cards(runId);
  const wrong = step({ step: 'resume', runId, batch: 'held', resume: { interruptId: '0000000000000000deadbeef', approvalId: card.approval_id, decision: 'approve' } });
  assert.equal(wrong.ok, false, 'a resume with the wrong id must fail');
  assert.equal(wrong.error?.status, 409);
  assert.equal(wrong.error?.name, 'StaleResumeError');
  assert.deepEqual(await effects(runId), [], 'the wrong id executed nothing — not even the read');
  // Still parked on the same interrupt: the right id still works.
  const again = step({ step: 'replay', runId, batch: 'held' });
  assert.deepEqual(again.pendingInterruptIds, s1.pendingInterruptIds);
  const right = step({ step: 'resume', runId, batch: 'held', resume: { interruptId: s1.pendingInterruptIds![0], approvalId: card.approval_id, decision: 'reject' } });
  assert.equal(right.reachedEnd, true, JSON.stringify(right.error));
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge'], 'rejected: the write never ran');
});

test('negative twin: the hold policy changes between pause and resume — a rejected call still never runs, a pending call stays held', { skip }, async () => {
  const runId = run('drift');
  const s1 = step({ step: 'start', runId, batch: 'held', policy: 'held' });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const interruptId = s1.pendingInterruptIds![0];
  const [card] = await cards(runId);

  // Pending + policy flipped to "not held": the decision recorded at pause time wins — still held.
  const s2 = step({ step: 'replay', runId, batch: 'held', policy: 'not-held' });
  assert.equal(s2.ok, true, JSON.stringify(s2.error));
  assert.equal(s2.parked, true, 'a pending call is still held after the policy flip');
  assert.deepEqual(s2.pendingInterruptIds, [interruptId]);
  assert.deepEqual(await effects(runId), []);

  // Rejected under the flipped policy: the call is answered with the typed rejection, never executed.
  const s3 = step({ step: 'resume', runId, batch: 'held', policy: 'not-held', resume: { interruptId, approvalId: card.approval_id, decision: 'reject' } });
  assert.equal(s3.ok, true, JSON.stringify(s3.error));
  assert.equal(s3.reachedEnd, true);
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge'], 'the rejected write never ran');
  const answer = JSON.parse(s3.toolResults?.request_promotion ?? '{}') as { error?: { code?: string; approvalId?: string } };
  assert.equal(answer.error?.code, 'rejected');
  assert.equal(answer.error?.approvalId, card.approval_id);
});
