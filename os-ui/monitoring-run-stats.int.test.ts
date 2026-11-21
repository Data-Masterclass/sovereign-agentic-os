/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Runs over time, failure classes and last failures per agent system — on a REAL
 *             postgres:17 holding the agent run store's own tables.
 * USER STORY: As an agentic engineer I want the runs chart to count exactly the runs the engine filed,
 *             each with the outcome `list_runs` shows, and never a run outside my scope.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh starts the chart's postgres image on :15532; the run store's DDL
 *     (`migrateRunJobs`) creates `run_jobs` / `run_events`; rows go in through the store's own
 *     `enqueue` / `complete` / `appendEvent`.
 *   - Negative twin: a run of the same system filed in another domain by another user is not
 *     counted for a creator, and is counted for an admin.
 *   - Lives beside instrumentation.ts because it needs two tabs: the Agents run store writes the rows,
 *     the Monitoring reader counts them (a tab never imports another tab, GLUE-9).
 *   - Run: MON_IT=1 node --import ./scripts/test-setup.mjs --test monitoring-run-stats.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateRunJobs, postgresRunJobStore } from '@tabs/agents/lib/engine/jobs-postgres';
import { runStats } from '@tabs/monitoring/lib/adapters/run-stats';

const on = process.env.MON_IT === '1';
const URL_ = process.env.MON_PG_URL ?? 'postgres://postgres:monit-not-a-secret@127.0.0.1:15532/postgres';

test('runStats counts runs per day and outcome, classifies failures and lists the last ones — in scope only', { skip: !on }, async () => {
  const pool = new pg.Pool({ connectionString: URL_, max: 2 });
  try {
    await migrateRunJobs(pool);
    const store = postgresRunJobStore(pool);
    const sys = `sys-${randomUUID().slice(0, 8)}`;
    const principal = (id: string, domains: string[]) => ({ id, name: id, role: 'creator' as const, domains, activeDomain: null });
    const file = async (requestedBy: string, domain: string, outcome: 'done' | 'failed' | 'parked' | 'budget') => {
      const runId = `run_${randomUUID()}`;
      await store.enqueue({ runId, systemId: sys, domain, requestedBy, principal: principal(requestedBy, [domain]), input: { task: 't' }, kind: 'start' } as never, Date.now());
      if (outcome === 'parked') {
        await store.complete(runId, 'parked', {});
      } else if (outcome === 'done') {
        await store.appendEvent(runId, 'done', { status: 'done', reachedEnd: true });
        await store.complete(runId, 'done', {});
      } else {
        const reason = outcome === 'budget' ? 'LiteLLM 429: {"error":{"message":"Budget has been exceeded!","type":"budget_exceeded"}}' : 'tool crashed';
        await store.appendEvent(runId, 'done', { status: 'failed', failed: true, failure: { node: 'writer', reason } });
        await store.complete(runId, 'done', {});
      }
      return runId;
    };
    await file('ada', 'sales', 'done');
    await file('ada', 'sales', 'done');
    await file('ada', 'sales', 'parked');
    const failed = await file('ada', 'sales', 'failed');
    await file('ada', 'sales', 'budget');
    await file('zoe', 'hr', 'failed'); // the negative twin: another user, another domain

    const since = new Date(Date.now() - 86_400_000);
    const mine = await runStats(pool, { systemIds: [sys], since, visibleTo: { requestedBy: 'ada', domains: [] } });
    const s = mine.get(sys);
    assert.ok(s, 'no stats for the system');
    const total = (k: 'done' | 'failed' | 'held' | 'other' | 'active') => s.days.reduce((n, d) => n + d[k], 0);
    assert.equal(total('done'), 2);
    assert.equal(total('failed'), 2, 'zoe’s failed run must not be counted for ada');
    assert.equal(total('held'), 1);
    assert.equal(s.failureClasses.budget_exceeded, 1);
    assert.equal(s.failureClasses.other, 1);
    assert.equal(s.lastFailures.length, 2);
    assert.ok(s.lastFailures.some((f) => f.runId === failed && f.node === 'writer' && f.reason === 'tool crashed'));
    assert.ok(s.lastFailures.every((f) => f.requestedBy === 'ada'));

    // Admin (no visibleTo): every run of the system.
    const all = await runStats(pool, { systemIds: [sys], since });
    assert.equal(all.get(sys)!.days.reduce((n, d) => n + d.failed, 0), 3);
    // A system nobody asked for is not read.
    assert.equal((await runStats(pool, { systemIds: [], since })).size, 0);
  } finally {
    await pool.end();
  }
});
