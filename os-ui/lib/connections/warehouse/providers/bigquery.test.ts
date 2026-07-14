/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigqueryProvider } from './bigquery.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

const CREDENTIALS_FILE = '/etc/trino/secrets/bq-sa.json';

// ---------------------------------------------------- BigQuery: SA-JSON mode ----

test('bigquery props: connector name + project-id (service-account mode)', () => {
  const src: WarehouseSource = {
    catalog: 'bq_sales',
    platform: 'bigquery',
    projectId: 'my-analytics-prod',
    credentialsSecretRef: 'bq-sa-secret',
  };
  const props = bigqueryProvider.catalogProps(src);
  assert.equal(props['connector.name'], 'bigquery');
  assert.equal(props['bigquery.project-id'], 'my-analytics-prod');
});

test('bigquery maps parent-project-id when set', () => {
  const props = bigqueryProvider.catalogProps({
    catalog: 'bq',
    platform: 'bigquery',
    projectId: 'owner-proj',
    parentProjectId: 'billing-proj',
    credentialsSecretRef: 'bq-sa-secret',
  });
  assert.equal(props['bigquery.parent-project-id'], 'billing-proj');
});

test('bigquery omits parent-project-id when not set', () => {
  const props = bigqueryProvider.catalogProps({
    catalog: 'bq',
    platform: 'bigquery',
    projectId: 'owner-proj',
    credentialsSecretRef: 'bq-sa-secret',
  });
  assert.ok(!('bigquery.parent-project-id' in props));
});

test('bigquery emits credentials-file PATH in service-account mode', () => {
  const props = bigqueryProvider.catalogProps({
    catalog: 'bq',
    platform: 'bigquery',
    projectId: 'owner-proj',
    credentialsSecretRef: 'bq-sa-secret',
  });
  assert.equal(props['bigquery.credentials-file'], CREDENTIALS_FILE);
});

test('bigquery NEVER inlines raw SA-JSON — only a file path is referenced', () => {
  const props = bigqueryProvider.catalogProps({
    catalog: 'bq',
    platform: 'bigquery',
    projectId: 'owner-proj',
    credentialsSecretRef: 'bq-sa-secret',
  });
  const serialized = JSON.stringify(props).toLowerCase();
  assert.ok(!serialized.includes('private_key'), 'no private_key JSON field');
  assert.ok(!serialized.includes('"type": "service_account"'), 'no inlined SA JSON');
  assert.ok(!('bigquery.credentials-key' in props), 'no base64 credentials-key');
});

// ---------------------------------------------- BigQuery: Workload Identity ----

test('bigquery emits NO credentials-file in Workload-Identity mode (no secret ref)', () => {
  const props = bigqueryProvider.catalogProps({
    catalog: 'bq',
    platform: 'bigquery',
    projectId: 'owner-proj',
  });
  assert.equal(props['connector.name'], 'bigquery');
  assert.equal(props['bigquery.project-id'], 'owner-proj');
  assert.ok(!('bigquery.credentials-file' in props), 'WI supplies creds — no file line');
  assert.ok(!('bigquery.credentials-key' in props));
});

// ------------------------------------------------------------------- guards ----

test('bigquery throws WarehouseError on missing projectId', () => {
  assert.throws(
    () =>
      bigqueryProvider.catalogProps({
        catalog: 'bq',
        platform: 'bigquery',
      } as unknown as WarehouseSource),
    (e: unknown) =>
      e instanceof WarehouseError && /projectId/.test((e as Error).message),
  );
});
