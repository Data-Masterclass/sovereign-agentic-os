/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportCtas } from './import.ts';
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
