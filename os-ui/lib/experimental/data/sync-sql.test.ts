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

// ---- Tenant-scoping / schema-smuggling tests -----------------------------------
// The DELETE target schema is ALWAYS derived from owner.id (personal_<slug>)
// by sync-run-server.ts — the body cannot pick an arbitrary schema.
// These tests pin that the SQL builder itself also cannot be tricked into emitting
// a schema outside the owner's personal lane when the schema identifier is validated.

test('deleteBatchSql schema is owner-derived: personal_lena deletes only from personal_lena', () => {
  // target.schema is derived from owner.id by the caller (sync-run-server.ts)
  // and cannot differ from the owner's personal lane.
  const ownerTarget = { schema: 'personal_lena', table: 'bronze_orders' };
  const sql = deleteBatchSql(ownerTarget, 'ds_1:100');
  assert.match(sql, /iceberg\.personal_lena\.bronze_orders/, 'DELETE targets the owner schema');
  assert.ok(!sql.includes('personal_maya'), 'cannot target a different user schema');
});

test('deleteBatchSql schema-smuggling: an adversarial schema identifier is rejected', () => {
  // If someone tries to supply a schema that smuggles SQL via an invalid identifier
  // the targetFqn validator must throw WarehouseError.
  assert.throws(
    () => deleteBatchSql({ schema: "personal_lena'; DROP TABLE iceberg.personal_maya.bronze_orders; --", table: 'bronze_orders' }, 'ds_1:100'),
    WarehouseError,
    'an injected schema must throw — it is not a valid catalog name',
  );
});

test('deleteBatchSql adversarial owner/batch combo: schema derived from owner.id only', () => {
  // Scenario: attacker controls the batchId but NOT the schema — the schema is owner.id.
  // Even with a valid batchId the DELETE stays scoped to the owner schema.
  const attackerBatch = 'ds_1:100'; // legitimate batchId format
  const legitTarget = { schema: 'personal_lena', table: 'bronze_orders' };
  const sql = deleteBatchSql(legitTarget, attackerBatch);
  // The only table touched is the owner's.
  assert.match(sql, /DELETE FROM iceberg\.personal_lena\.bronze_orders/);
  // Ensure no other schema appears.
  assert.ok(!sql.includes('personal_maya') && !sql.includes('domain_') && !sql.includes('shared_'));
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

// ------------------------------------------------------------- kafka offsets --

import {
  kafkaAppendSql,
  kafkaFullLoadSql,
  kafkaHasNew,
  kafkaOffsetsProbeSql,
  mergeKafkaOffsets,
  parseKafkaOffsets,
  serializeKafkaOffsets,
} from './sync-sql.ts';

const kafkaSource = { catalog: 'kafka_events', schema: 'default', table: 'orders' };
const kafkaLineage = { batchId: 'ds_1.k', loadedAt: '2026-02-01T00:00:00Z' };
const KAFKA_SELECT_HEAD =
  'SELECT *, _partition_id AS _kafka_partition, _partition_offset AS _kafka_offset, ' +
  "TIMESTAMP '2026-02-01 00:00:00' AS _loaded_at, 'ds_1.k' AS _batch_id ";

test('kafkaOffsetsProbeSql probes per-partition highs on the federated topic', () => {
  assert.equal(
    kafkaOffsetsProbeSql(kafkaSource),
    'SELECT _partition_id, max(_partition_offset) AS hw FROM kafka_events.default.orders GROUP BY _partition_id',
  );
});

test('kafka offsets serialize canonically, parse tolerantly, merge without regression', () => {
  assert.equal(serializeKafkaOffsets({ '10': '5', '2': '7' }), '{"2":"7","10":"5"}');
  assert.deepEqual(parseKafkaOffsets('{"0":"41","1":"7"}'), { '0': '41', '1': '7' });
  assert.equal(parseKafkaOffsets('not json'), null);
  assert.equal(parseKafkaOffsets('{"0":"drop table"}'), null);
  assert.equal(parseKafkaOffsets(null), null);
  // Merge takes the per-partition MAX — a shrunken probe (retention) never regresses.
  assert.deepEqual(mergeKafkaOffsets({ '0': '50' }, { '0': '10', '1': '3' }), { '0': '50', '1': '3' });
  assert.throws(() => serializeKafkaOffsets({ '0': '1; DROP' }), WarehouseError);
});

test('kafkaHasNew detects advanced or brand-new partitions', () => {
  assert.equal(kafkaHasNew(null, { '0': '1' }), true);
  assert.equal(kafkaHasNew({ '0': '5' }, { '0': '5' }), false);
  assert.equal(kafkaHasNew({ '0': '5' }, { '0': '6' }), true);
  assert.equal(kafkaHasNew({ '0': '5' }, { '0': '5', '1': '0' }), true);
  assert.equal(kafkaHasNew(null, {}), false);
});

test('kafkaAppendSql emits per-partition offset windows with lineage + offset columns', () => {
  const sql = kafkaAppendSql({
    target,
    source: kafkaSource,
    before: { '0': '41', '1': '7' },
    highs: { '0': '100', '1': '7', '2': '3' },
    ...kafkaLineage,
  });
  assert.equal(
    sql,
    `INSERT INTO iceberg.personal_lena.bronze_orders ${KAFKA_SELECT_HEAD}` +
      'FROM kafka_events.default.orders WHERE ' +
      '(_partition_id = 0 AND _partition_offset > 41 AND _partition_offset <= 100) OR ' +
      '(_partition_id = 2 AND _partition_offset <= 3)',
    'partition 1 (no new offsets) is omitted; new partition 2 has no lower bound',
  );
});

test('kafkaFullLoadSql CREATEs OR REPLACEs the copy bounded to the probed highs', () => {
  const sql = kafkaFullLoadSql({ target, source: kafkaSource, highs: { '0': '41' }, ...kafkaLineage });
  assert.equal(
    sql,
    `CREATE OR REPLACE TABLE iceberg.personal_lena.bronze_orders AS ${KAFKA_SELECT_HEAD}` +
      'FROM kafka_events.default.orders WHERE (_partition_id = 0 AND _partition_offset <= 41)',
  );
});

test('kafka builders validate everything folded into SQL', () => {
  const base = { target, source: kafkaSource, before: null, ...kafkaLineage };
  assert.throws(() => kafkaAppendSql({ ...base, highs: {} }), WarehouseError);
  assert.throws(() => kafkaAppendSql({ ...base, highs: { '0': '1 OR 1=1' } }), WarehouseError);
  assert.throws(() => kafkaAppendSql({ ...base, highs: { 'x': '1' } }), WarehouseError);
  assert.throws(
    () => kafkaAppendSql({ ...base, highs: { '0': '1' }, batchId: "x' OR '1'='1" }),
    WarehouseError,
  );
});

// The generated kafka statements must clear the query-tool guard's allowlisted
// shapes (mirrored from images/query-tool/execute_guard.py — INSERT INTO … SELECT,
// CREATE OR REPLACE … AS SELECT, DELETE … WHERE _batch_id = '<id>').
test('kafka SQL matches the query-tool guard shapes (mirror cross-check)', () => {
  const RE_INSERT_SELECT = /^insert\s+into\s+iceberg\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+select\b[\s\S]*$/i;
  const RE_CTAS_REPLACE = /^create\s+or\s+replace\s+table\s+iceberg\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+as\s+select\b[\s\S]*$/i;
  const append = kafkaAppendSql({ target, source: kafkaSource, before: { '0': '1' }, highs: { '0': '9' }, ...kafkaLineage });
  const full = kafkaFullLoadSql({ target, source: kafkaSource, highs: { '0': '9' }, ...kafkaLineage });
  assert.match(append, RE_INSERT_SELECT);
  assert.match(full, RE_CTAS_REPLACE);
  for (const sql of [append, full]) {
    assert.ok(!sql.includes(';') && !sql.includes('--') && !sql.includes('/*'), 'no comments / extra statements');
  }
});

// ---------------------------------------------- operational sources (postgres) --

// The timestamp-cursor slice against a federated OPERATIONAL catalog (postgresql/
// mysql/sqlserver) must clear the query-tool guard's insert_select shape — the same
// mirror the kafka cross-check uses. (The guard's own suite re-checks the literal
// SQL: images/query-tool/test_execute_guard.py::SyncGeneratedSqlTests.)
test('operational-database slice SQL clears the guard mirror (postgresql catalog)', () => {
  const sql = appendSql({
    target,
    source: { catalog: 'pg_erp', schema: 'public', table: 'orders' },
    cursor: tsCursor,
    watermark: '2026-01-01 00:00:00',
    highWatermark: '2026-02-01 00:00:00',
    ...lineage,
  });
  assert.match(sql, /^insert\s+into\s+iceberg\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+select\b[\s\S]*$/i);
  assert.ok(!sql.includes(';') && !sql.includes('--') && !sql.includes('/*'));
});
