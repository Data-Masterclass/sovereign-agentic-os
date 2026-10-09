/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityChecks } from './dq-run.ts';
import type { DataCheck } from './dataset-schema.ts';

const FQN = 'iceberg.sales.gold_orders';
function chk(over: Partial<DataCheck>): DataCheck {
  return { id: Math.random().toString(36).slice(2), name: '', description: '', createdBy: 'amir', createdAt: '', ...over };
}

test('a rule with 0 violations passes; > 0 fails', async () => {
  const seen: string[] = [];
  const report = await runQualityChecks(
    [
      chk({ id: 'ok', rule: 'not_null', column: 'order_id' }),
      chk({ id: 'bad', rule: 'range', column: 'amount', min: 0 }),
    ],
    {
      fqn: FQN,
      queryFn: async (sql) => {
        seen.push(sql);
        return { rows: sql.includes('"amount"') ? [['4']] : [['0']] };
      },
    },
    () => '2026-01-01T00:00:00.000Z',
  );
  assert.equal(report.results.find((r) => r.id === 'ok')!.status, 'pass');
  assert.equal(report.results.find((r) => r.id === 'bad')!.status, 'fail');
  assert.equal(report.results.find((r) => r.id === 'bad')!.violations, 4);
  assert.equal(report.badge, 'failing'); // a fail dominates
  assert.equal(report.ranAt, '2026-01-01T00:00:00.000Z');
  assert.equal(seen.length, 2);
});

test('all rules pass ⇒ badge passing', async () => {
  const report = await runQualityChecks(
    [chk({ rule: 'not_null', column: 'order_id' }), chk({ rule: 'unique', column: 'order_id' })],
    { fqn: FQN, queryFn: async () => ({ rows: [['0']] }) },
  );
  assert.equal(report.badge, 'passing');
  assert.ok(report.results.every((r) => r.status === 'pass'));
});

test('no built layer (fqn null) ⇒ every rule not_run, badge unknown (never a fake pass)', async () => {
  let called = false;
  const report = await runQualityChecks(
    [chk({ rule: 'not_null', column: 'order_id' })],
    { fqn: null, queryFn: async () => { called = true; return { rows: [['0']] }; } },
  );
  assert.equal(called, false); // we never query a table that doesn't exist
  assert.equal(report.results[0].status, 'not_run');
  assert.equal(report.badge, 'unknown');
});

test('a non-executable (free-text) check is not_run, not a pass', async () => {
  const report = await runQualityChecks(
    [chk({ name: 'legacy: no null ids' })],
    { fqn: FQN, queryFn: async () => ({ rows: [['0']] }) },
  );
  assert.equal(report.results[0].status, 'not_run');
  assert.match(report.results[0].reason ?? '', /free-text|executable/i);
  assert.equal(report.badge, 'unknown');
});

test('a rule whose query throws (table not materialized) is not_run, never a pass', async () => {
  const report = await runQualityChecks(
    [chk({ rule: 'not_null', column: 'order_id' })],
    { fqn: FQN, queryFn: async () => { throw new Error('TABLE_NOT_FOUND'); } },
  );
  assert.equal(report.results[0].status, 'not_run');
  assert.match(report.results[0].reason ?? '', /TABLE_NOT_FOUND/);
  assert.equal(report.badge, 'unknown');
});
