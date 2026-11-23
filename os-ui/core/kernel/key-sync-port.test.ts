/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The pre-run key-sync seam: every run door asks it, and it never fails a run
 * USER STORY: As the owner a run never fails because the system's model key lags behind its definition.
 * ARCHITECTURE: the real seam; the run queue's call site is pinned by reading its source (the queue itself needs a store).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preRunKeySync, registerPreRunKeySync } from '@core/kernel/key-sync-port';

test('registered: the implementation runs with the system and the actor', async () => {
  const seen: string[] = [];
  registerPreRunKeySync(async (id, actor) => { seen.push(`${id}/${actor}`); });
  assert.equal(await preRunKeySync('sys_a', 'user:u1'), 'synced-or-checked');
  assert.deepEqual(seen, ['sys_a/user:u1']);
  registerPreRunKeySync(undefined);
});

test('TWIN: nothing registered (the worker) → nothing happens; a throwing implementation never fails the run', async () => {
  assert.equal(await preRunKeySync('sys_a', 'u'), 'not-registered');
  registerPreRunKeySync(async () => { throw new Error('gateway down'); });
  assert.equal(await preRunKeySync('sys_a', 'u'), 'failed');
  registerPreRunKeySync(undefined);
});

test('every run door files through enqueueRun, and enqueueRun asks the seam before filing', () => {
  const src = readFileSync(new URL('../../tabs/agents/lib/build/run-jobs-server.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function enqueueRun('));
  assert.ok(body.indexOf('await preRunKeySync(') > 0 && body.indexOf('await preRunKeySync(') < body.indexOf('store.enqueue(job)'), 'synced before the job is filed');
});
