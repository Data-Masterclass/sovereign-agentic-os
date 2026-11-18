/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents / run worker
 * FEATURE:    refreshSystemFromMirror — the worker reads a system fresh before running it
 * USER STORY: As a user I want "Run" to find my agent system when the run executes in the worker
 *             pod (0.9.2: every run failed "System not found" because the worker never loaded the
 *             registry), and to run the definition I just edited, not the one the worker booted with.
 * ARCHITECTURE: pure unit tests with an injected mirror reader; the process flag is toggled via
 *               the write-availability seams.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __resetStore, __recordFor, refreshSystemFromMirror } from './store.ts';
import { markRunWorkerProcess, __clearRunWorkerProcess } from './write-availability.ts';

const doc = (id: string, name: string) => ({ id, name, domain: 'sales', owner: 'u1', visibility: 'Personal', yaml: `version: '1'\nsystem:\n  name: ${name}\n` });

test('outside the worker process the refresh is a no-op and memory is untouched', async () => {
  __resetStore();
  __clearRunWorkerProcess();
  assert.equal(await refreshSystemFromMirror('sys_a', async () => doc('sys_a', 'A')), 'not-worker');
  assert.equal(__recordFor('sys_a'), undefined);
});

test('in the worker a cold registry learns the system from the mirror, and an edit overwrites memory', async () => {
  __resetStore();
  markRunWorkerProcess();
  try {
    assert.equal(await refreshSystemFromMirror('sys_a', async () => doc('sys_a', 'A v1')), 'refreshed');
    assert.equal(__recordFor('sys_a')?.name, 'A v1');
    assert.equal(await refreshSystemFromMirror('sys_a', async () => doc('sys_a', 'A v2')), 'refreshed');
    assert.equal(__recordFor('sys_a')?.name, 'A v2', 'the worker must run the EDITED definition');
  } finally {
    __clearRunWorkerProcess();
  }
});

test('a missing or unreachable mirror answer leaves memory exactly as it was', async () => {
  __resetStore();
  markRunWorkerProcess();
  try {
    await refreshSystemFromMirror('sys_a', async () => doc('sys_a', 'A v1'));
    assert.equal(await refreshSystemFromMirror('sys_a', async () => null), 'unavailable');
    assert.equal(__recordFor('sys_a')?.name, 'A v1');
    assert.equal(await refreshSystemFromMirror('sys_b', async () => ({ id: 'sys_other' })), 'unavailable');
    assert.equal(__recordFor('sys_b'), undefined);
  } finally {
    __clearRunWorkerProcess();
  }
});

test('the executor refreshes before it looks a system up, and the worker hydrates the registry at boot', () => {
  const exec = readFileSync(join(process.cwd(), 'tabs/agents/lib/build/run-jobs-server.ts'), 'utf8');
  const i = exec.indexOf('await refreshSystemFromMirror(job.systemId)');
  const j = exec.indexOf('getSystemForRun(job.systemId, user)');
  assert.ok(i > 0 && j > i, 'refreshSystemFromMirror must precede getSystemForRun in the executor');
  const worker = readFileSync(join(process.cwd(), 'worker/agent-runs.ts'), 'utf8');
  assert.match(worker, /ensureHydrated: hydrateSystems[^}]*\} = await import\('@tabs\/agents\/lib\/store'\)/);
  assert.match(worker, /await hydrateSystems\(\)/);
});
