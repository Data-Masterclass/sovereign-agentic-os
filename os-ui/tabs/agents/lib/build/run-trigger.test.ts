/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The run_jobs row records what started a run (schedule / api), through the REAL door
 * USER STORY: As an operator reading `run_jobs` I want `input->>'trigger'` to say whether a run came
 *             from a schedule or an API caller, so an unattended run is never mistaken for a click.
 * ARCHITECTURE:
 *   - The REAL `startQueuedRun` → `enqueueRun` → the in-memory `RunJobStore` (no
 *     AGENT_RUNS_DATABASE_URL). `AGENTS_WORKER=worker`, so this process files the job and does not
 *     execute it (no engine, no model): the row as filed is exactly what the worker would claim.
 *   - The doors pass `trigger` (scheduled.ts: 'schedule', MCP run_agent_system: 'api'); their own
 *     tests (scheduled.test.ts, core/mcp/wave-a.test.ts) assert that they do.
 */
process.env.AGENTS_WORKER = 'worker';
delete process.env.AGENT_RUNS_DATABASE_URL;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startQueuedRun, runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');

const USER = { id: 'owner1', name: 'Owner', domains: ['finance'], allDomains: ['finance'], activeDomain: null, role: 'creator' as const };

async function filed(runId: string, trigger?: 'schedule' | 'api' | 'manual', env?: 'run') {
  const out = await startQueuedRun({
    user: USER,
    systemId: 'sys-trigger',
    domain: 'finance',
    messages: [{ role: 'user', content: 'Scheduled run' }],
    prompt: 'Scheduled run',
    runId,
    waitMs: 20,
    ...(trigger ? { trigger } : {}),
    ...(env ? { env } : {}),
  });
  assert.equal(out.mode, 'worker', 'filed for the worker, not executed here');
  return (await runJobStore()).get(runId);
}

test('a scheduled start files a row with trigger=schedule (and env=run)', async () => {
  const row = await filed('run-trigger-schedule', 'schedule', 'run');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.kind, 'start');
  assert.equal(row?.input.trigger, 'schedule');
  assert.equal(row?.input.env, 'run');
});

test('an API start files a row with trigger=api', async () => {
  const row = await filed('run-trigger-api', 'api');
  assert.equal(row?.input.trigger, 'api');
  assert.equal(row?.input.env, undefined, 'an API run is not the pinned-definition lifecycle');
});

test('a start with no trigger records none (never a guessed one)', async () => {
  const row = await filed('run-trigger-none');
  assert.equal(row?.input.trigger, undefined);
});
