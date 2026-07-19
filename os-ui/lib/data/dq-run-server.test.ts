/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAndRecord, isNewFailure } from './dq-run-server.ts';
import { __resetDqResults, latestRun } from './dq-results.ts';
import type { Dataset } from './dataset-schema.ts';

function dataset(over: Partial<Dataset> = {}): Dataset {
  return {
    version: '1', id: 'ds1', name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset',
    visibility: 'shared', folder: '/', description: '', grants: [], measures: [], columns: [],
    versions: { bronze: {} as never, silver: {} as never, gold: {} as never },
    checks: [{ id: 'c1', name: '', description: '', createdBy: 'amir', createdAt: '', rule: 'not_null', column: 'id' }],
    ...over,
  } as Dataset;
}

beforeEach(() => __resetDqResults());

test('isNewFailure: fires only on a fresh transition INTO failing', () => {
  assert.equal(isNewFailure('failing', null), true, 'first-ever failure fires');
  assert.equal(isNewFailure('failing', 'passing'), true, 'pass → fail fires');
  assert.equal(isNewFailure('failing', 'failing'), false, 'still failing does not re-fire');
  assert.equal(isNewFailure('passing', 'failing'), false, 'recovery does not fire');
  assert.equal(isNewFailure('unknown', null), false, 'nothing-ran never fires');
});

test('runAndRecord: no built layer ⇒ every rule not_run, honest badge, persisted', async () => {
  const out = await runAndRecord(dataset(), {
    fqn: null,
    queryFn: async () => ({ rows: [] }),
    ownerId: 'amir',
    now: () => '2026-07-19T00:00:00.000Z',
    history: [],
  });
  assert.equal(out.badge, 'unknown');
  assert.equal(out.health.score, null, 'no fake 100 when nothing ran');
  assert.equal(out.results[0].status, 'not_run');
  assert.equal(latestRun('ds1')?.badge, 'unknown', 'the run was persisted');
});

test('runAndRecord: a failing rule ⇒ failing badge; row-count + schema captured', async () => {
  // queryFn answers: the not_null violations count (5), the count(*) probe (100), describe.
  const calls: string[] = [];
  const out = await runAndRecord(dataset(), {
    fqn: 'iceberg.sales.gold_orders',
    queryFn: async (sql) => {
      calls.push(sql);
      if (/^describe/i.test(sql)) return { rows: [['id', 'bigint'], ['name', 'varchar']] };
      if (/count\(\*\) as v from iceberg\.sales\.gold_orders$/.test(sql)) return { rows: [['100']] };
      // the not_null violations count
      return { rows: [['5']] };
    },
    ownerId: 'amir',
    now: () => '2026-07-19T00:00:00.000Z',
    history: [],
  });
  assert.equal(out.badge, 'failing');
  assert.equal(out.rowCount, 100, 'row count probed via count(*)');
  assert.ok(out.schemaFingerprint?.includes('id:bigint'), 'schema fingerprint captured');
  // monitors need >=3 history points, so with empty history they are honestly not_run.
  const monitors = out.results.filter((r) => r.id.startsWith('monitor:'));
  assert.equal(monitors.length, 3);
  assert.ok(monitors.every((m) => m.status === 'not_run'), 'monitors not_run with no history');
});

test('runAndRecord: omAppend receives each rule verdict after the run', async () => {
  const appended: { count: number; ranAt: string; statuses: string[] } = { count: 0, ranAt: '', statuses: [] };
  const out = await runAndRecord(dataset(), {
    fqn: 'iceberg.sales.gold_orders',
    queryFn: async (sql) => {
      if (/^describe/i.test(sql)) return { rows: [['id', 'bigint']] };
      if (/count\(\*\) as v from iceberg\.sales\.gold_orders$/.test(sql)) return { rows: [['100']] };
      return { rows: [['0']] }; // not_null passes
    },
    ownerId: 'amir',
    now: () => '2026-07-19T00:00:00.000Z',
    history: [],
    omAppend: async (results, ranAt) => {
      appended.count += 1;
      appended.ranAt = ranAt;
      appended.statuses = results.map((r) => r.status);
    },
  });
  assert.equal(out.badge, 'passing');
  assert.equal(appended.count, 1, 'omAppend was invoked exactly once, after the run');
  assert.equal(appended.ranAt, '2026-07-19T00:00:00.000Z', 'appender got the run timestamp');
  assert.ok(appended.statuses.includes('pass'), 'appender saw the rule verdict');
});

test('runAndRecord: a throwing omAppend never fails the governed DQ run (OM-down is a no-op)', async () => {
  const out = await runAndRecord(dataset(), {
    fqn: 'iceberg.sales.gold_orders',
    queryFn: async (sql) => {
      if (/^describe/i.test(sql)) return { rows: [['id', 'bigint']] };
      if (/count\(\*\) as v from iceberg\.sales\.gold_orders$/.test(sql)) return { rows: [['100']] };
      return { rows: [['0']] };
    },
    ownerId: 'amir',
    now: () => '2026-07-19T00:00:00.000Z',
    history: [],
    omAppend: async () => { throw new Error('OM unreachable'); },
  });
  // The run still succeeds and is persisted — OM enrichment is additive, never blocking.
  assert.equal(out.badge, 'passing');
  assert.equal(latestRun('ds1')?.badge, 'passing', 'the run was still persisted despite the OM failure');
});

test('runAndRecord: schema-drift monitor fails against prior history', async () => {
  const out = await runAndRecord(dataset({ checks: [] }), {
    fqn: 'iceberg.sales.gold_orders',
    queryFn: async (sql) => {
      if (/^describe/i.test(sql)) return { rows: [['id', 'bigint'], ['email', 'varchar']] };
      if (/count\(\*\)/.test(sql)) return { rows: [['100']] };
      return { rows: [['0']] };
    },
    ownerId: 'amir',
    now: () => '2026-07-19T00:00:00.000Z',
    history: [
      { ranAt: '2026-07-18T00:00:00.000Z', rowCount: 100, schemaFingerprint: 'id:bigint,name:varchar' },
    ],
  });
  const schema = out.results.find((r) => r.id === 'monitor:schema');
  assert.equal(schema?.status, 'fail', 'schema drift is caught vs the prior snapshot');
  assert.ok(/email/.test(schema?.reason ?? ''), 'names the added column');
});
