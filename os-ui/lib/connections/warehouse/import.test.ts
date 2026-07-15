/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportCtas, buildTypedImportCtas, planImportColumn } from './import.ts';
import { WarehouseError } from './types.ts';

test('buildImportCtas builds the governed CTAS into the OS Iceberg lakehouse', () => {
  const sql = buildImportCtas(
    { domain: 'sales', name: 'orders' },
    { catalog: 'glue_sales', schema: 'raw', table: 'orders' },
  );
  assert.equal(
    sql,
    'CREATE TABLE iceberg.sales.orders AS SELECT * FROM glue_sales.raw.orders',
  );
});

test('buildImportCtas validates every identifier (no injection)', () => {
  assert.throws(
    () => buildImportCtas({ domain: 'sales', name: 'x; DROP TABLE y' }, { catalog: 'g', schema: 's', table: 't' }),
    (e: unknown) => e instanceof WarehouseError && /name/.test((e as Error).message),
  );
  assert.throws(
    () => buildImportCtas({ domain: 'sales', name: 'orders' }, { catalog: 'g', schema: 's', table: 'bad table' }),
    (e: unknown) => e instanceof WarehouseError && /table/.test((e as Error).message),
  );
  assert.throws(
    () => buildImportCtas({ domain: 'Sales', name: 'orders' }, { catalog: 'g', schema: 's', table: 't' }),
    (e: unknown) => e instanceof WarehouseError && /domain/.test((e as Error).message),
  );
});

// -------------------------------------------- engine-specific typed import (CTAS casts) --

test('typed import with no columns falls back to plain SELECT * (back-compatible)', () => {
  const plan = buildTypedImportCtas(
    { domain: 'sales', name: 'orders' },
    { catalog: 'sf_sales', schema: 'raw', table: 'orders' },
    'snowflake',
    [],
  );
  assert.equal(plan.sql, 'CREATE TABLE iceberg.sales.orders AS SELECT * FROM sf_sales.raw.orders');
  assert.deepEqual(plan.warnings, []);
});

test('snowflake VARIANT column is CAST to json honestly (with a warning)', () => {
  const plan = buildTypedImportCtas(
    { domain: 'sales', name: 'events' },
    { catalog: 'sf_sales', schema: 'raw', table: 'events' },
    'snowflake',
    [
      { name: 'id', type: 'NUMBER' },
      { name: 'payload', type: 'VARIANT' },
    ],
  );
  assert.equal(
    plan.sql,
    'CREATE TABLE iceberg.sales.events AS SELECT id, CAST(payload AS json) AS payload FROM sf_sales.raw.events',
  );
  assert.ok(plan.warnings.some((w) => /payload/.test(w) && /VARIANT/.test(w)), 'warns on the lossy VARIANT cast');
});

test('bigquery STRUCT/ARRAY → json and GEOGRAPHY → varchar', () => {
  const plan = buildTypedImportCtas(
    { domain: 'sales', name: 'geo' },
    { catalog: 'bq_sales', schema: 'ds', table: 'geo' },
    'bigquery',
    [
      { name: 'loc', type: 'GEOGRAPHY' },
      { name: 'tags', type: 'ARRAY<STRING>' },
      { name: 'meta', type: 'STRUCT<a INT64>' },
    ],
  );
  assert.match(plan.sql, /CAST\(loc AS varchar\) AS loc/);
  assert.match(plan.sql, /CAST\(tags AS json\) AS tags/);
  assert.match(plan.sql, /CAST\(meta AS json\) AS meta/);
  assert.equal(plan.warnings.length, 3);
});

test('scalar columns with no matching rule pass through unchanged', () => {
  const plan = buildTypedImportCtas(
    { domain: 'sales', name: 't' },
    { catalog: 'bq', schema: 'ds', table: 't' },
    'bigquery',
    [
      { name: 'n', type: 'INT64' },
      { name: 's', type: 'STRING' },
    ],
  );
  assert.equal(plan.sql, 'CREATE TABLE iceberg.sales.t AS SELECT n, s FROM bq.ds.t');
  assert.deepEqual(plan.warnings, []);
});

test('planImportColumn rejects an unsafe (injectable) source column name', () => {
  assert.throws(
    () => planImportColumn({ name: 'x; DROP TABLE y', type: 'varchar' }, undefined),
    (e: unknown) => e instanceof WarehouseError && /column/.test((e as Error).message),
  );
});

test('typed import validates the target identifiers like the untyped path', () => {
  assert.throws(
    () =>
      buildTypedImportCtas(
        { domain: 'Sales', name: 'orders' },
        { catalog: 'g', schema: 's', table: 't' },
        'glue',
        [{ name: 'c', type: 'varchar' }],
      ),
    (e: unknown) => e instanceof WarehouseError && /domain/.test((e as Error).message),
  );
});
