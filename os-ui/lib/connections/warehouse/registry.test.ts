/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAREHOUSE_PROVIDERS, providerFor } from './registry.ts';
import { trinoCatalogProps } from './catalog-props.ts';
import {
  WAREHOUSE_PLATFORMS,
  WarehouseError,
  type WarehouseSource,
} from './types.ts';

test('providerFor resolves every platform, and each is well-formed', () => {
  for (const platform of WAREHOUSE_PLATFORMS) {
    const provider = providerFor(platform);
    assert.equal(provider.platform, platform, `provider for ${platform} matches its key`);
    assert.equal(WAREHOUSE_PROVIDERS[platform], provider);
    assert.ok(provider.label.length > 0, `${platform} has a label`);
    assert.ok(provider.trinoConnector.length > 0, `${platform} has a trinoConnector`);
    assert.equal(typeof provider.catalogProps, 'function');
  }
});

test('registry stays in sync with the platform union', () => {
  assert.deepEqual(
    Object.keys(WAREHOUSE_PROVIDERS).sort(),
    [...WAREHOUSE_PLATFORMS].sort(),
  );
});

// Glue must produce EXACTLY the props the old inline switch produced.
test('Glue provider produces the same props the old switch did (iceberg)', () => {
  const src: WarehouseSource = {
    catalog: 'glue_sales',
    platform: 'glue',
    region: 'eu-central-1',
    glueCatalogId: '123456789012',
  };
  assert.deepEqual(trinoCatalogProps(src), {
    'connector.name': 'iceberg',
    'iceberg.catalog.type': 'glue',
    'hive.metastore.glue.region': 'eu-central-1',
    'hive.metastore.glue.catalogid': '123456789012',
    'fs.native-s3.enabled': 'true',
    's3.region': 'eu-central-1',
  });
});

test('Glue provider produces the same props the old switch did (hive)', () => {
  const src: WarehouseSource = {
    catalog: 'g',
    platform: 'glue',
    region: 'us-east-1',
    format: 'hive',
    defaultWarehouseDir: 's3://lake/hive',
  };
  assert.deepEqual(trinoCatalogProps(src), {
    'connector.name': 'hive',
    'hive.metastore': 'glue',
    'hive.metastore.glue.region': 'us-east-1',
    'hive.metastore.glue.default-warehouse-dir': 's3://lake/hive',
    'fs.native-s3.enabled': 'true',
    's3.region': 'us-east-1',
  });
});

test('every registered provider is implemented — no 501 stub remains', () => {
  for (const platform of ['snowflake', 'bigquery', 'databricks-delta', 'fabric'] as const) {
    assert.throws(
      () => providerFor(platform).catalogProps({ catalog: 'x', platform } as unknown as WarehouseSource),
      (e: unknown) =>
        e instanceof WarehouseError &&
        !/not yet implemented in Phase 1/.test((e as Error).message),
      platform,
    );
  }
});
