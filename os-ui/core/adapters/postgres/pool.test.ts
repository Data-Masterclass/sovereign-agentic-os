/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / adapters / postgres
 * FEATURE:    The agent_runs pool grows with the worker's parallel runs
 * USER STORY: As an operator who raises `osUI.worker.concurrency` for a course, I want the worker's
 *             database pool to grow with it, so six parallel runs do not queue for a connection.
 * ARCHITECTURE: pure sizing function; the pool itself is built lazily in `agentRunsPool`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_RUNS_POOL_MAX, agentRunsPoolMax } from '@core/adapters/postgres/pool';

test('agent_runs pool: base size for one run, plus two connections per extra parallel run', () => {
  assert.equal(agentRunsPoolMax(1), AGENT_RUNS_POOL_MAX);
  assert.equal(agentRunsPoolMax(6), AGENT_RUNS_POOL_MAX + 10);
  assert.equal(agentRunsPoolMax(0), AGENT_RUNS_POOL_MAX, 'junk is one slot, never a smaller pool');
  assert.equal(agentRunsPoolMax(Number.NaN), AGENT_RUNS_POOL_MAX);
});
