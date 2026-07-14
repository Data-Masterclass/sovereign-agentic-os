/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Guard 1 (durability): a compiled `CREATE OR REPLACE TABLE <fqn> AS <select>` must
 * never silently zero-out a POPULATED table when the SELECT yields 0 rows (the verify
 * runs AFTER the replace, so it's too late by then). `assertNoZeroRowReplace` pre-flights
 * the row counts under the same identity and ABORTS only for the replace-populated-with-
 * 0-rows case; a fresh target or a >0-row select proceeds.
 *
 * We stub `@/lib/core/config` so no real query-tool URL is needed and inject a fake
 * `run` (the queryRun shape) so the counts are fully under test control.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('@/lib/core/config', {
  namedExports: { config: { queryToolUrl: 'http://qt.test', opaUrl: 'http://opa.test' } },
});
mock.module('@/lib/infra/governed', {
  namedExports: {
    queryRun: async () => ({ engine: 'trino', tables: [], columns: [], rows: [], rowCount: 0 }),
    executeRun: async () => ({ ok: true, rowsAffected: null }),
    cubeLoad: async () => ({ rows: [], annotation: {} }),
  },
});

const { assertNoZeroRowReplace } = await import('./live-clients.ts');

const CTAS = 'create or replace table iceberg.sales.gold_orders as select a from t';

/** A fake queryRun that answers count(*) probes from a scripted map (sql substring → n). */
function fakeRun(counts: { existing?: number | Error; incoming?: number | Error }) {
  return async (sql: string) => {
    const wants = sql.includes('FROM (') ? 'incoming' : 'existing';
    const v = counts[wants as 'existing' | 'incoming'];
    if (v instanceof Error) throw v;
    const n = typeof v === 'number' ? v : 0;
    return { engine: 'trino', tables: [], columns: ['_c0'], rows: [[String(n)]], rowCount: 1 };
  };
}

test('(a) 0-row select over a populated target → ABORT', async () => {
  await assert.rejects(
    () => assertNoZeroRowReplace(CTAS, 'sales', fakeRun({ existing: 12, incoming: 0 }) as never),
    /refusing to replace populated table iceberg\.sales\.gold_orders with a 0-row result/,
  );
});

test('(b) >0-row select over a populated target → proceeds', async () => {
  await assert.doesNotReject(() =>
    assertNoZeroRowReplace(CTAS, 'sales', fakeRun({ existing: 12, incoming: 5 }) as never),
  );
});

test('(c) target does not exist yet (probe throws) → proceeds', async () => {
  await assert.doesNotReject(() =>
    assertNoZeroRowReplace(CTAS, 'sales', fakeRun({ existing: new Error('TABLE_NOT_FOUND') }) as never),
  );
});

test('empty (0-row) target → proceeds even with a 0-row select (nothing to lose)', async () => {
  await assert.doesNotReject(() =>
    assertNoZeroRowReplace(CTAS, 'sales', fakeRun({ existing: 0, incoming: 0 }) as never),
  );
});

test('non-CTAS statement → no-op (nothing to guard)', async () => {
  await assert.doesNotReject(() =>
    assertNoZeroRowReplace('select * from t', 'sales', fakeRun({ existing: 12, incoming: 0 }) as never),
  );
});

test('incoming-count probe error → proceeds (never a false abort on a transient probe failure)', async () => {
  await assert.doesNotReject(() =>
    assertNoZeroRowReplace(CTAS, 'sales', fakeRun({ existing: 12, incoming: new Error('transient') }) as never),
  );
});
