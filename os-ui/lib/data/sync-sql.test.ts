/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSql,
  cursorLiteral,
  deleteBatchSql,
  expireSnapshotsSql,
  fullRefreshSql,
  highWatermarkProbeSql,
  mergeSql,
  optimizeSql,
} from './sync-sql.ts';
import { WarehouseError } from '../connections/warehouse/types.ts';

const target = { schema: 'personal_lena', table: 'bronze_orders' };
const source = { catalog: 'pg_shop', schema: 'public', table: 'orders' };
const tsCursor = { kind: 'timestamp' as const, column: 'updated_at' };
const numCursor = { kind: 'number' as const, column: 'id' };

// --------------------------------------------------------------- full refresh --

test('fullRefreshSql reuses the import CTAS with OR REPLACE', () => {
  assert.equal(
    fullRefreshSql(target, source),
    'CREATE OR REPLACE TABLE iceberg.personal_lena.bronze_orders AS SELECT * FROM pg_shop.public.orders',
  );
});

test('fullRefreshSql validates identifiers (no injection)', () => {
  assert.throws(
    () => fullRefreshSql({ schema: 'personal_lena', table: 'x; DROP TABLE y' }, source),
    WarehouseError,
  );
});

// -------------------------------------------------------------- cursor literals --

test('cursorLiteral: numbers pass through validated', () => {
  assert.equal(cursorLiteral('number', '42'), '42');
  assert.equal(cursorLiteral('number', '-3.5'), '-3.5');
  assert.throws(() => cursorLiteral('number', '42 OR 1=1'), WarehouseError);
});

test('cursorLiteral: timestamps are normalised + quoted', () => {
  assert.equal(cursorLiteral('timestamp', '2026-01-02 03:04:05.123'), "TIMESTAMP '2026-01-02 03:04:05.123'");
  assert.equal(cursorLiteral('timestamp', '2026-01-02T03:04:05Z'), "TIMESTAMP '2026-01-02 03:04:05'");
  assert.equal(cursorLiteral('timestamp', '2026-01-02'), "TIMESTAMP '2026-01-02'");
  assert.throws(() => cursorLiteral('timestamp', "2026-01-02' OR '1'='1"), WarehouseError);
  assert.throws(() => cursorLiteral('timestamp', 'now()'), WarehouseError);
});

test('cursorLiteral: reserved kinds are honestly unimplemented', () => {
  assert.throws(() => cursorLiteral('delta-version', '12'), /not implemented/);
});

// -------------------------------------------------------------------- probe --

test('highWatermarkProbeSql probes max(cursor) on the federated source', () => {
  assert.equal(
    highWatermarkProbeSql(source, tsCursor),
    'SELECT max(updated_at) AS hw FROM pg_shop.public.orders',
  );
  assert.throws(() => highWatermarkProbeSql(source, { kind: 'timestamp', column: 'bad col' }), WarehouseError);
});

// -------------------------------------------------------------------- append --

const lineage = { batchId: 'ds_1:100', loadedAt: '2026-02-01T00:00:00Z' };
const LINEAGE_COLS = "TIMESTAMP '2026-02-01 00:00:00' AS _loaded_at, 'ds_1:100' AS _batch_id";

test('appendSql emits the bounded INSERT ... SELECT with lineage columns + default lookback', () => {
  const sql = appendSql({
    target,
    source,
    cursor: tsCursor,
    watermark: '2026-01-01 00:00:00',
    highWatermark: '2026-02-01 00:00:00',
    ...lineage,
  });
  assert.equal(
    sql,
    `INSERT INTO iceberg.personal_lena.bronze_orders SELECT *, ${LINEAGE_COLS} FROM pg_shop.public.orders ` +
      "WHERE updated_at > TIMESTAMP '2026-01-01 00:00:00' - INTERVAL '15' MINUTE " +
      "AND updated_at <= TIMESTAMP '2026-02-01 00:00:00'",
  );
});

test('appendSql honours an explicit lookback (and 0 disables it)', () => {
  const base = { target, source, cursor: tsCursor, watermark: '2026-01-01 00:00:00', highWatermark: '2026-02-01 00:00:00', ...lineage };
  assert.ok(appendSql({ ...base, lookbackMinutes: 60 }).includes("- INTERVAL '60' MINUTE"));
  assert.ok(!appendSql({ ...base, lookbackMinutes: 0 }).includes('INTERVAL'));
  assert.throws(() => appendSql({ ...base, lookbackMinutes: -5 }), WarehouseError);
});

test('appendSql number cursors get no lookback', () => {
  const sql = appendSql({ target, source, cursor: numCursor, watermark: '50', highWatermark: '100', ...lineage });
  assert.ok(sql.includes('WHERE id > 50 AND id <= 100'));
});

test('appendSql first run (no watermark) takes everything up to HW', () => {
  const sql = appendSql({ target, source, cursor: numCursor, watermark: null, highWatermark: '100', ...lineage });
  assert.equal(
    sql,
    `INSERT INTO iceberg.personal_lena.bronze_orders SELECT *, ${LINEAGE_COLS} FROM pg_shop.public.orders WHERE id <= 100`,
  );
});

test('appendSql validates the batch id (no quote smuggling)', () => {
  assert.throws(
    () => appendSql({ target, source, cursor: numCursor, watermark: null, highWatermark: '1', batchId: "x' OR '1'='1", loadedAt: '2026-01-01' }),
    WarehouseError,
  );
});

test('deleteBatchSql un-lands exactly one batch', () => {
  assert.equal(
    deleteBatchSql(target, 'ds_1:100'),
    "DELETE FROM iceberg.personal_lena.bronze_orders WHERE _batch_id = 'ds_1:100'",
  );
  assert.throws(() => deleteBatchSql(target, "a' OR true"), WarehouseError);
});

// --------------------------------------------------------------------- merge --

test('mergeSql compiles staging CTAS + MERGE + DROP with explicit columns', () => {
  const { staging, merge, drop, stagingTable } = mergeSql({
    target,
    source,
    cursor: numCursor,
    watermark: '5',
    highWatermark: '10',
    mergeKeys: ['id'],
    columns: ['id', 'amount', 'status'],
  });
  assert.equal(stagingTable, 'bronze_orders_stg');
  assert.equal(
    staging,
    'CREATE OR REPLACE TABLE iceberg.personal_lena.bronze_orders_stg AS ' +
      'SELECT * FROM pg_shop.public.orders WHERE id > 5 AND id <= 10',
  );
  assert.equal(
    merge,
    'MERGE INTO iceberg.personal_lena.bronze_orders AS t USING iceberg.personal_lena.bronze_orders_stg AS s ' +
      'ON t.id = s.id ' +
      'WHEN MATCHED THEN UPDATE SET amount = s.amount, status = s.status ' +
      'WHEN NOT MATCHED THEN INSERT (id, amount, status) VALUES (s.id, s.amount, s.status)',
  );
  assert.equal(drop, 'DROP TABLE IF EXISTS iceberg.personal_lena.bronze_orders_stg');
});

test('mergeSql with only key columns omits the UPDATE clause', () => {
  const { merge } = mergeSql({
    target,
    source,
    cursor: numCursor,
    watermark: null,
    highWatermark: '10',
    mergeKeys: ['id'],
    columns: ['id'],
  });
  assert.ok(!merge.includes('WHEN MATCHED'));
  assert.ok(merge.includes('WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)'));
});

test('mergeSql validates keys and columns', () => {
  const base = { target, source, cursor: numCursor, watermark: null, highWatermark: '10' };
  assert.throws(() => mergeSql({ ...base, mergeKeys: [], columns: ['id'] }), /at least one merge key/);
  assert.throws(() => mergeSql({ ...base, mergeKeys: ['id'], columns: [] }), /column list/);
  assert.throws(() => mergeSql({ ...base, mergeKeys: ['nope'], columns: ['id'] }), /not one of the columns/);
  assert.throws(() => mergeSql({ ...base, mergeKeys: ['id; DROP'], columns: ['id; DROP'] }), WarehouseError);
});

// --------------------------------------------------------------- maintenance --

test('expireSnapshotsSql emits the guarded maintenance statement', () => {
  assert.equal(
    expireSnapshotsSql(target),
    "ALTER TABLE iceberg.personal_lena.bronze_orders EXECUTE expire_snapshots(retention_threshold => '7d')",
  );
  assert.equal(
    expireSnapshotsSql(target, '48h'),
    "ALTER TABLE iceberg.personal_lena.bronze_orders EXECUTE expire_snapshots(retention_threshold => '48h')",
  );
  assert.throws(() => expireSnapshotsSql(target, "7d'); DROP TABLE x; --"), WarehouseError);
});

test('optimizeSql emits the guarded compaction statement', () => {
  assert.equal(optimizeSql(target), 'ALTER TABLE iceberg.personal_lena.bronze_orders EXECUTE optimize');
});
