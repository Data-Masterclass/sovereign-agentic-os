/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogRegistration } from './registration.ts';
import type { WarehouseSource } from './types.ts';

test('catalogRegistration renders Glue props + a keyless values snippet', () => {
  const source: WarehouseSource = { catalog: 'glue_sales', platform: 'glue', region: 'eu-central-1' };
  const reg = catalogRegistration(source);
  assert.equal(reg.name, 'glue_sales');
  assert.equal(reg.props['connector.name'], 'iceberg');
  // IRSA: no secret env / keys, and the snippet says so.
  assert.deepEqual(reg.envVars, []);
  assert.deepEqual(reg.secretKeys, []);
  assert.match(reg.valuesSnippet, /- name: glue_sales/);
  assert.match(reg.valuesSnippet, /platform: glue/);
  assert.match(reg.valuesSnippet, /properties: \|/);
  assert.match(reg.valuesSnippet, /connector\.name=iceberg/);
  assert.match(reg.valuesSnippet, /cloud-native identity/); // the "no secrets" note
  // A snippet must never carry a secret VALUE — only env-references.
  assert.ok(!/BEGIN PRIVATE KEY/.test(reg.valuesSnippet));
});

test('catalogRegistration surfaces the secret env plumbing for Snowflake', () => {
  const source: WarehouseSource = {
    catalog: 'snow_fin',
    platform: 'snowflake',
    accountUrl: 'https://ORG-ACCT.snowflakecomputing.com',
    database: 'ANALYTICS',
    warehouse: 'WH',
    username: 'svc',
  };
  const reg = catalogRegistration(source);
  assert.deepEqual(reg.envVars, ['SNOWFLAKE_PRIVATE_KEY']);
  assert.deepEqual(reg.secretKeys, ['snowflake-private-key']);
  // The prop references the env var; the PEM itself is NEVER in the snippet.
  assert.match(reg.valuesSnippet, /connection-private-key=\$\{ENV:SNOWFLAKE_PRIVATE_KEY\}/);
  assert.match(reg.valuesSnippet, /- name: SNOWFLAKE_PRIVATE_KEY/);
  assert.equal(reg.openMetadata.connectorType, 'Snowflake');
});
