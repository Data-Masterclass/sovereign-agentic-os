/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Per-thread in-flight lock — two concurrent resumes execute the approved write once
 * USER STORY: As a domain admin who approved a held write I need it to run exactly once even when the
 *             runner resumes the same thread at the same moment (A2 review M-B; checklist A16).
 * ARCHITECTURE: the pure lock (`run-lock.ts`) around a simulated resume whose "approved write" is a
 *             counter; plus a source tripwire that `executeTeamRun` takes the lock (the server module
 *             cannot be imported under node --test).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, RunInFlightError, runInFlight, __resetRunLocks } from '@tabs/agents/lib/engine/run-lock';

beforeEach(() => __resetRunLocks());

test('RUN-LOCK: a second entrant on the same thread is refused, typed 409; the first releases', () => {
  const release = acquireRunLock('run_a');
  assert.equal(runInFlight('run_a'), true);
  assert.throws(() => acquireRunLock('run_a'), (e: unknown) => e instanceof RunInFlightError && (e as RunInFlightError).status === 409);
  // Another thread is unaffected.
  acquireRunLock('run_b')();
  release();
  release(); // idempotent
  assert.equal(runInFlight('run_a'), false);
  acquireRunLock('run_a')();
});

test('RUN-LOCK (A16): two concurrent resumes of one thread execute the approved write ONCE', async () => {
  let writes = 0;
  const resume = async (runId: string) => {
    const release = acquireRunLock(runId);
    try {
      // The approved write re-executed by `tools_<id>` on resume.
      await new Promise((r) => setTimeout(r, 5));
      writes += 1;
      return 'done';
    } finally {
      release();
    }
  };
  const outcomes = await Promise.allSettled([resume('run_x'), resume('run_x')]);
  assert.equal(writes, 1, 'the write ran twice — the lock did not serialise the resumes');
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(refused.reason instanceof RunInFlightError);
  // After the first finished, a later resume is accepted again.
  assert.equal(await resume('run_x'), 'done');
});

test('RUN-LOCK tripwire: executeTeamRun acquires the lock before any marker and releases in finally', () => {
  const src = readFileSync(fileURLToPath(new URL('../build/run-service.ts', import.meta.url)), 'utf8');
  const fn = src.slice(src.indexOf('export async function executeTeamRun'));
  const acquire = fn.indexOf('acquireRunLock(runId)');
  assert.ok(acquire > 0, 'executeTeamRun must take the per-thread lock');
  assert.ok(acquire < fn.indexOf('setActivity('), 'the lock is taken before the activity marker');
  assert.ok(acquire < fn.indexOf('openRunTopic('), 'the lock is taken before the run topic opens');
  assert.match(fn, /finally \{[\s\S]*release\(\);/, 'the lock is released in finally');
});
