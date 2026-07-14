/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Databricks / Delta Lake provider — pure `catalogProps` tests.
 *
 * These lock the two sub-modes' rendered Trino props and the security invariant
 * that the PAT is NEVER inlined (only ${ENV:DATABRICKS_TOKEN}). The exact Unity
 * key NAMES are UNVERIFIED against OSS Trino 476 (see the provider header); these
 * tests pin the SHAPE the provider emits, not that a live 476 image accepts them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databricksProvider } from './databricks.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

const props = (src: Partial<WarehouseSource> & { catalog?: string }) =>
  databricksProvider.catalogProps({
    catalog: 'db_delta',
    platform: 'databricks-delta',
    ...src,
  } as WarehouseSource);

// ------------------------------------------------------------- connector name ---

test('connector.name is delta_lake (underscore) in both modes', () => {
  const unity = props({
    host: 'https://dbc-x.cloud.databricks.com',
    unityCatalog: 'main',
    tokenSecretRef: 'vault/db-token',
  });
  const storage = props({ host: 'dbc-x.cloud.databricks.com', metastoreUri: 'thrift://hms:9083' });
  assert.equal(unity['connector.name'], 'delta_lake');
  assert.equal(storage['connector.name'], 'delta_lake');
});

// ------------------------------------------------------------- Unity mode -------

test('Unity mode emits the unity keys + token via ${ENV:DATABRICKS_TOKEN}', () => {
  const p = props({
    host: 'https://dbc-abc.cloud.databricks.com',
    unityCatalog: 'main',
    tokenSecretRef: 'vault/db-token',
  });
  assert.equal(p['hive.metastore'], 'unity');
  assert.equal(p['unity.host'], 'dbc-abc.cloud.databricks.com'); // scheme stripped
  assert.equal(p['unity.catalog.name'], 'main');
  assert.equal(p['unity.token'], '${ENV:DATABRICKS_TOKEN}');
});

test('Unity mode: no inline token anywhere in the props', () => {
  const p = props({
    host: 'dbc-abc.cloud.databricks.com',
    unityCatalog: 'main',
    tokenSecretRef: 'vault/super-secret-pat-value',
  });
  for (const v of Object.values(p)) {
    // Only the ${ENV:...} reference may mention the token; no literal secret leaks.
    assert.ok(
      !/super-secret-pat-value/.test(v),
      `no vault ref value should leak into props (found in '${v}')`,
    );
  }
  assert.equal(p['unity.token'], '${ENV:DATABRICKS_TOKEN}');
});

test('Unity mode carries S3 native fs when storage is s3://', () => {
  const p = props({
    host: 'dbc.cloud.databricks.com',
    unityCatalog: 'main',
    tokenSecretRef: 'vault/db-token',
    storage: 's3://lake/delta',
  });
  assert.equal(p['fs.native-s3.enabled'], 'true');
});

// ---------------------------------------------------- storage / HMS mode --------

test('storage mode with metastoreUri emits the thrift metastore keys', () => {
  const p = props({
    host: 'dbc.cloud.databricks.com',
    metastoreUri: 'thrift://hms.internal:9083',
    storage: 's3://lake/delta',
  });
  assert.equal(p['connector.name'], 'delta_lake');
  assert.equal(p['hive.metastore'], 'thrift');
  assert.equal(p['hive.metastore.uri'], 'thrift://hms.internal:9083');
  assert.equal(p['fs.native-s3.enabled'], 'true');
  // Not Unity: no unity keys, no token.
  assert.equal(p['hive.metastore'] === 'unity', false);
  assert.equal('unity.token' in p, false);
});

test('storage mode without a thrift URI defaults to the glue metastore', () => {
  const p = props({ host: 'dbc.cloud.databricks.com', storage: 's3://lake/delta' });
  assert.equal(p['hive.metastore'], 'glue');
  assert.equal(p['fs.native-s3.enabled'], 'true');
  assert.equal('hive.metastore.uri' in p, false);
});

test('storage mode maps abfss:// to the native Azure filesystem', () => {
  const p = props({
    host: 'dbc.cloud.databricks.com',
    metastoreUri: 'thrift://hms:9083',
    storage: 'abfss://container@acct.dfs.core.windows.net/delta',
  });
  assert.equal(p['fs.native-azure.enabled'], 'true');
  assert.equal('fs.native-s3.enabled' in p, false);
});

// ------------------------------------------------------------- validation -------

test('missing host throws WarehouseError', () => {
  assert.throws(
    () => props({ metastoreUri: 'thrift://hms:9083' } as Partial<WarehouseSource>),
    (e: unknown) => e instanceof WarehouseError && /host/.test((e as Error).message),
  );
});

test('Unity mode without a tokenSecretRef throws WarehouseError', () => {
  assert.throws(
    () => props({ host: 'dbc.cloud.databricks.com', unityCatalog: 'main' }),
    (e: unknown) => e instanceof WarehouseError && /tokenSecretRef/.test((e as Error).message),
  );
});

test('non-Unity mode with neither metastoreUri nor storage throws WarehouseError', () => {
  assert.throws(
    () => props({ host: 'dbc.cloud.databricks.com' }),
    (e: unknown) => e instanceof WarehouseError && /metastoreUri|storage/.test((e as Error).message),
  );
});

test('a non-thrift metastoreUri is rejected', () => {
  assert.throws(
    () => props({ host: 'dbc.cloud.databricks.com', metastoreUri: 'http://hms:9083' }),
    (e: unknown) => e instanceof WarehouseError && /thrift/.test((e as Error).message),
  );
});

// ------------------------------------------------------------- metadata ---------

test('secretMaterial mounts the PAT as DATABRICKS_TOKEN only', () => {
  assert.deepEqual(databricksProvider.secretMaterial, {
    secretKeys: ['databricks-token'],
    envVars: ['DATABRICKS_TOKEN'],
  });
});

test('testProbe renders a cheap SHOW SCHEMAS round-trip', () => {
  assert.equal(databricksProvider.testProbe.kind, 'sql');
  if (databricksProvider.testProbe.kind === 'sql') {
    assert.equal(
      databricksProvider.testProbe.query({ catalog: 'db_delta' } as WarehouseSource),
      'SHOW SCHEMAS FROM db_delta',
    );
  }
});

test('liveVerificationRequired flags the unverified Unity key names', () => {
  const joined = databricksProvider.liveVerificationRequired.join(' ');
  assert.ok(/unity/i.test(joined), 'mentions Unity');
  assert.ok(/476/.test(joined), 'flags the trino-476 key uncertainty');
});
