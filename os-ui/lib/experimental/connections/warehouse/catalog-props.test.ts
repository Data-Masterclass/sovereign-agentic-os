/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trinoCatalogProps, externalTableFqn } from './catalog-props.ts';
import { WarehouseError, type WarehouseSource } from './types.ts';

// --------------------------------------------------------------- Glue: iceberg --

test('glue iceberg props: connector, glue catalog type, region, native s3', () => {
  const src: WarehouseSource = {
    catalog: 'glue_sales',
    platform: 'glue',
    region: 'eu-central-1',
  };
  const props = trinoCatalogProps(src);
  assert.equal(props['connector.name'], 'iceberg');
  assert.equal(props['iceberg.catalog.type'], 'glue');
  assert.equal(props['hive.metastore.glue.region'], 'eu-central-1');
  assert.equal(props['fs.native-s3.enabled'], 'true');
  assert.equal(props['s3.region'], 'eu-central-1');
});

test('glue props NEVER emit static AWS credentials (IRSA only)', () => {
  const props = trinoCatalogProps({ catalog: 'g', platform: 'glue', region: 'us-east-1' });
  const serialized = JSON.stringify(props).toLowerCase();
  assert.ok(!serialized.includes('aws-access-key'), 'no aws-access-key line');
  assert.ok(!serialized.includes('aws-secret-key'), 'no aws-secret-key line');
  assert.ok(!('s3.aws-access-key' in props));
  assert.ok(!('s3.aws-secret-key' in props));
});

test('glue iceberg passes cross-account catalog id when present', () => {
  const props = trinoCatalogProps({
    catalog: 'g',
    platform: 'glue',
    region: 'us-east-1',
    glueCatalogId: '123456789012',
  });
  assert.equal(props['hive.metastore.glue.catalogid'], '123456789012');
});

// ------------------------------------------------------------------ Glue: hive --

test('glue hive props: hive connector + hive.metastore=glue', () => {
  const props = trinoCatalogProps({
    catalog: 'g',
    platform: 'glue',
    region: 'us-east-1',
    format: 'hive',
    defaultWarehouseDir: 's3://lake/hive',
  });
  assert.equal(props['connector.name'], 'hive');
  assert.equal(props['hive.metastore'], 'glue');
  assert.equal(props['hive.metastore.glue.default-warehouse-dir'], 's3://lake/hive');
  assert.ok(!('iceberg.catalog.type' in props));
});

// -------------------------------------------------------------------- guards ----

test('rejects an invalid Trino catalog name', () => {
  assert.throws(
    () => trinoCatalogProps({ catalog: 'Bad-Name', platform: 'glue', region: 'us-east-1' }),
    (e: unknown) => e instanceof WarehouseError && /invalid Trino catalog name/.test((e as Error).message),
  );
});

test('rejects a missing / malformed region', () => {
  assert.throws(
    () => trinoCatalogProps({ catalog: 'g', platform: 'glue', region: '' }),
    (e: unknown) => e instanceof WarehouseError,
  );
});

test('every platform is implemented — none is a Phase-1 501 stub', () => {
  // Empty config still throws a *validation* WarehouseError, but never the old
  // "not yet implemented in Phase 1" stub message — proving each provider is real.
  for (const platform of ['snowflake', 'bigquery', 'databricks-delta', 'fabric'] as const) {
    assert.throws(
      () => trinoCatalogProps({ catalog: 'x', platform } as unknown as WarehouseSource),
      (e: unknown) =>
        e instanceof WarehouseError &&
        !/not yet implemented in Phase 1/.test((e as Error).message),
      platform,
    );
  }
});

// ------------------------------------------------------------- FQN mapping ------

test('externalTableFqn builds the three-part governed FQN', () => {
  assert.equal(externalTableFqn('glue_sales', 'public', 'orders'), 'glue_sales.public.orders');
});

test('externalTableFqn rejects malformed segments', () => {
  assert.throws(() => externalTableFqn('glue', 'sch ema', 'orders'), WarehouseError);
  assert.throws(() => externalTableFqn('glue', 'public', ''), WarehouseError);
  assert.throws(() => externalTableFqn('9glue', 'public', 'orders'), WarehouseError);
});
