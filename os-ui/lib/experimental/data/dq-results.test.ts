/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetDqResults,
  recordRun,
  listRuns,
  latestRun,
  healthTrend,
  MAX_RUNS_PER_DATASET,
  type DqRunRecord,
} from './dq-results.ts';
import type { CheckResult, QualityBadge } from './dq.ts';

// osMirror.writeThrough is fire-and-forget and graceful (an unreachable OpenSearch is a
// no-op, never a throw), so these assert the in-process append/trim/trend behaviour —
// the durability path is covered by os-mirror-stores.test.ts.

const results = (badge: QualityBadge): CheckResult[] =>
  badge === 'passing'
    ? [{ id: 'a', label: '', status: 'pass', violations: 0 }]
    : badge === 'failing'
      ? [{ id: 'a', label: '', status: 'fail', violations: 3 }]
      : [{ id: 'a', label: '', status: 'not_run', violations: null, reason: 'x' }];

function run(datasetId: string, ranAt: string, badge: QualityBadge, score: number | null): DqRunRecord {
  return recordRun({ datasetId, ranAt, badge, healthScore: score, results: results(badge), ranBy: 'amir', domain: 'sales' });
}

beforeEach(() => __resetDqResults());

test('a dataset with no runs reads honestly empty (no fabricated pass)', () => {
  assert.deepEqual(listRuns('ds1'), []);
  assert.equal(latestRun('ds1'), null);
  assert.deepEqual(healthTrend('ds1'), []);
});

test('recordRun appends a time-series; latestRun returns the newest', () => {
  run('ds1', '2026-01-01T00:00:00.000Z', 'passing', 100);
  run('ds1', '2026-01-02T00:00:00.000Z', 'failing', 60);
  const runs = listRuns('ds1');
  assert.equal(runs.length, 2);
  // oldest → newest
  assert.equal(runs[0].ranAt, '2026-01-01T00:00:00.000Z');
  assert.equal(latestRun('ds1')!.badge, 'failing');
  assert.equal(latestRun('ds1')!.healthScore, 60);
});

test('runs are isolated per dataset', () => {
  run('ds1', '2026-01-01T00:00:00.000Z', 'passing', 100);
  run('ds2', '2026-01-01T00:00:00.000Z', 'failing', 40);
  assert.equal(listRuns('ds1').length, 1);
  assert.equal(listRuns('ds2').length, 1);
  assert.equal(latestRun('ds1')!.healthScore, 100);
  assert.equal(latestRun('ds2')!.healthScore, 40);
});

test('two runs on the same millisecond both persist (no clobber)', () => {
  run('ds1', '2026-01-01T00:00:00.000Z', 'passing', 100);
  run('ds1', '2026-01-01T00:00:00.000Z', 'failing', 50);
  assert.equal(listRuns('ds1').length, 2);
});

test('history is trimmed to the recent window per dataset', () => {
  for (let i = 0; i < MAX_RUNS_PER_DATASET + 5; i++) {
    const ranAt = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString();
    run('ds1', ranAt, 'passing', 100);
  }
  assert.equal(listRuns('ds1').length, MAX_RUNS_PER_DATASET);
  // The OLDEST rows were dropped — the newest are kept.
  const first = listRuns('ds1')[0].ranAt;
  assert.equal(first, new Date(Date.UTC(2026, 0, 1) + 5 * 86_400_000).toISOString());
});

test('healthTrend keeps an honest null point when a run measured nothing', () => {
  run('ds1', '2026-01-01T00:00:00.000Z', 'passing', 100);
  run('ds1', '2026-01-02T00:00:00.000Z', 'unknown', null);
  const trend = healthTrend('ds1');
  assert.deepEqual(trend.map((t) => t.score), [100, null]);
  assert.deepEqual(trend.map((t) => t.badge), ['passing', 'unknown']);
});
