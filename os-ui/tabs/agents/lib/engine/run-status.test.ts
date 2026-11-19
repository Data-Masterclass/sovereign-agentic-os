/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    How a run ended — tests of the one-word outcome and the reported job status
 * USER STORY: As the person who started a run I want a failed run to read "failed", also when
 *             an older version stored its job row as done.
 * ARCHITECTURE:
 *   - Pure tests of `runOutcomeOf` and `reportedJobStatus`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportedJobStatus, runOutcomeOf } from '@tabs/agents/lib/engine/run-status';

test('runOutcomeOf: one word for how a run ended — failed beats everything but parked', () => {
  const base = { parked: false, failed: false, interrupted: false, reachedEnd: true };
  assert.equal(runOutcomeOf(base), 'done');
  assert.equal(runOutcomeOf({ ...base, reachedEnd: false, failed: true }), 'failed');
  assert.equal(runOutcomeOf({ ...base, reachedEnd: false, parked: true, interrupted: true }), 'parked');
  assert.equal(runOutcomeOf({ ...base, reachedEnd: false, interrupted: true }), 'interrupted');
  // Stopped at the step budget: it neither failed nor finished.
  assert.equal(runOutcomeOf({ ...base, reachedEnd: false }), 'incomplete');
});

test('reportedJobStatus: a failed run reads `failed` even when its job row was settled `done` before this fix', () => {
  assert.equal(reportedJobStatus('done', { failed: true, parked: false, finished: true }), 'failed');
  assert.equal(reportedJobStatus('failed', { failed: true, parked: false, finished: true }), 'failed');
  assert.equal(reportedJobStatus('done', { failed: false, parked: false, finished: true }), 'done');
  assert.equal(reportedJobStatus('running', { failed: false, parked: false, finished: false }), 'running');
  assert.equal(reportedJobStatus('parked', { failed: false, parked: true, finished: false }), 'parked');
  // No job row (the event store was unreachable): the checkpoint alone still answers.
  assert.equal(reportedJobStatus(undefined, { failed: true, parked: false, finished: true }), 'failed');
  assert.equal(reportedJobStatus(undefined, { failed: false, parked: true, finished: false }), 'parked');
  assert.equal(reportedJobStatus(undefined, { failed: false, parked: false, finished: true }), 'done');
  assert.equal(reportedJobStatus(undefined, { failed: false, parked: false, finished: false }), undefined);
});
