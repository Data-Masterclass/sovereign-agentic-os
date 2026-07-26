/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetSyncRuns,
  consecutiveErrorCount,
  currentWatermark,
  isQuarantined,
  lastMaintenanceAt,
  latestSyncRun,
  listSyncRuns,
  MAX_SYNC_RUNS_PER_DATASET,
  QUARANTINE_THRESHOLD,
  recordSyncRun,
  type SyncRunStatus,
} from './sync-runs.ts';

// osMirror.writeThrough is fire-and-forget and graceful (unreachable OpenSearch is a
// no-op), so these assert the in-process append/trim/derivation behaviour — the
// durability path is covered by os-mirror-stores.test.ts.

let t = 0;
beforeEach(() => {
  __resetSyncRuns();
  t = 0;
});

function run(
  datasetId: string,
  status: SyncRunStatus,
  over: Partial<Parameters<typeof recordSyncRun>[0]> = {},
) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, t++)).toISOString();
  return recordSyncRun({
    datasetId,
    startedAt: at,
    finishedAt: at,
    status,
    mode: 'append',
    ranBy: 'amir',
    ...over,
  });
}

test('append + list + latest are chronological and per-dataset', () => {
  run('a', 'ok', { cursorAfter: '10' });
  run('b', 'error', { error: 'boom' });
  run('a', 'error', { error: 'later' });
  assert.equal(listSyncRuns('a').length, 2);
  assert.equal(latestSyncRun('a')?.error, 'later');
  assert.equal(latestSyncRun('b')?.status, 'error');
  assert.equal(latestSyncRun('c'), null);
});

test('trim keeps only the recent window per dataset', () => {
  for (let i = 0; i < MAX_SYNC_RUNS_PER_DATASET + 7; i++) run('a', 'ok');
  assert.equal(listSyncRuns('a').length, MAX_SYNC_RUNS_PER_DATASET);
});

test('currentWatermark = cursorAfter of the LATEST ok run (errors/skips do not advance)', () => {
  assert.equal(currentWatermark('a'), null);
  run('a', 'ok', { cursorAfter: '10' });
  run('a', 'ok', { cursorAfter: '20' });
  run('a', 'error', { cursorBefore: '20' });
  run('a', 'skipped');
  assert.equal(currentWatermark('a'), '20');
});

test('quarantine derives from trailing consecutive errors and clears on ok', () => {
  for (let i = 0; i < QUARANTINE_THRESHOLD - 1; i++) run('a', 'error');
  assert.equal(isQuarantined('a'), false);
  run('a', 'skipped'); // skips are stepped over, not evidence
  run('a', 'error');
  assert.equal(consecutiveErrorCount('a'), QUARANTINE_THRESHOLD);
  assert.equal(isQuarantined('a'), true);
  run('a', 'ok', { cursorAfter: '5' }); // a successful manual run clears quarantine
  assert.equal(isQuarantined('a'), false);
});

test('lastMaintenanceAt reads the newest maintenance run', () => {
  assert.equal(lastMaintenanceAt('a'), null);
  run('a', 'ok');
  const m = run('a', 'ok', { maintenance: true });
  run('a', 'ok');
  assert.equal(lastMaintenanceAt('a'), m.finishedAt);
});

test('same-millisecond appends never clobber', () => {
  const at = '2026-01-01T00:00:00.000Z';
  recordSyncRun({ datasetId: 'a', startedAt: at, finishedAt: at, status: 'ok', mode: 'append', ranBy: 'x' });
  recordSyncRun({ datasetId: 'a', startedAt: at, finishedAt: at, status: 'error', mode: 'append', ranBy: 'x' });
  assert.equal(listSyncRuns('a').length, 2);
});

// ------------------------------------------- running rows + in-place updates --

import { updateSyncRun } from './sync-runs.ts';

test('running rows are not error evidence and updateSyncRun finalizes in place', () => {
  __resetSyncRuns();
  const base = { datasetId: 'dsr', finishedAt: 'x', mode: 'append' as const, ranBy: 'u' };
  recordSyncRun({ ...base, startedAt: '2026-01-01T00:00:00Z', status: 'error', error: 'boom' });
  const running = recordSyncRun({
    ...base, startedAt: '2026-01-01T01:00:00Z', status: 'running',
    cursorBefore: '5', highWatermark: '9', batchId: 'dsr.9',
  });
  // A trailing 'running' marker is stepped over — the error streak stays visible.
  assert.equal(consecutiveErrorCount('dsr'), 1);
  assert.equal(currentWatermark('dsr'), null);

  const done = updateSyncRun(running.id, { status: 'ok', cursorAfter: '9', rowsAffected: 3, finishedAt: 'y' });
  assert.ok(done && done.status === 'ok');
  assert.equal(listSyncRuns('dsr').length, 2, 'finalized in place — no third row');
  assert.equal(currentWatermark('dsr'), '9');
  assert.equal(consecutiveErrorCount('dsr'), 0, 'the ok run resets the streak');
  assert.equal(done!.highWatermark, '9', 'the window survives the finalize');

  assert.equal(updateSyncRun('nope', { status: 'ok' }), null, 'unknown id is an honest null');
});
