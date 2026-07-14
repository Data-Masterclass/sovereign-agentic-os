/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWarehouseFields, toWarehouseSource } from './connection.ts';
import { trinoCatalogProps } from './catalog-props.ts';
import { WarehouseError } from './types.ts';

// Glue: region is non-secret config; there are NO secret fields (IRSA).
test('splitWarehouseFields keeps Glue config on the record, no secrets', () => {
  const { config, secrets } = splitWarehouseFields({
    platform: 'glue',
    catalog: 'glue_sales',
    fields: { region: 'eu-central-1', glueCatalogId: '123456789012' },
  });
  assert.deepEqual(config, { region: 'eu-central-1', glueCatalogId: '123456789012' });
  assert.deepEqual(secrets, {}); // IRSA — no secret material at all
});

// Snowflake: the PEM field is secret-keyed → it must NOT land in the record config.
test('splitWarehouseFields routes secret fields to secrets, never config', () => {
  const { config, secrets } = splitWarehouseFields({
    platform: 'snowflake',
    catalog: 'snow_fin',
    fields: {
      accountUrl: 'https://ORG-ACCT.snowflakecomputing.com',
      database: 'ANALYTICS',
      warehouse: 'WH',
      username: 'svc',
      'snowflake-private-key': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    },
  });
  assert.equal(config['accountUrl'], 'https://ORG-ACCT.snowflakecomputing.com');
  assert.equal(config['database'], 'ANALYTICS');
  assert.ok(!('snowflake-private-key' in config), 'the PEM never lands on the record');
  assert.equal(secrets['snowflake-private-key'], '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
});

test('splitWarehouseFields rejects a missing required field', () => {
  assert.throws(
    () => splitWarehouseFields({ platform: 'glue', catalog: 'g', fields: {} }),
    (e: unknown) => e instanceof WarehouseError && /region/.test((e as Error).message),
  );
});

test('splitWarehouseFields rejects a bad catalog name and unknown fields', () => {
  assert.throws(
    () => splitWarehouseFields({ platform: 'glue', catalog: 'Bad Name', fields: { region: 'eu' } }),
    (e: unknown) => e instanceof WarehouseError && /catalog name/.test((e as Error).message),
  );
  assert.throws(
    () => splitWarehouseFields({ platform: 'glue', catalog: 'g', fields: { region: 'eu', nope: 'x' } }),
    (e: unknown) => e instanceof WarehouseError && /unknown field/.test((e as Error).message),
  );
});

// The record's non-secret config round-trips back into a source the props generator
// accepts — proving the split is loss-less for the props path (secrets are env-refs).
test('toWarehouseSource rebuilds a source the props generator accepts', () => {
  const { config } = splitWarehouseFields({
    platform: 'glue',
    catalog: 'glue_sales',
    fields: { region: 'eu-central-1' },
  });
  const source = toWarehouseSource({ platform: 'glue', catalog: 'glue_sales', config });
  const props = trinoCatalogProps(source);
  assert.equal(props['connector.name'], 'iceberg');
  assert.equal(props['hive.metastore.glue.region'], 'eu-central-1');
  // Provably no static key in the rendered props (the IRSA discipline).
  assert.ok(!('s3.aws-access-key' in props));
});
