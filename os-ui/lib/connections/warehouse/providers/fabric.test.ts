/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricProvider } from './fabric.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

/** A well-formed Fabric/OneLake source; `override` tweaks one field per test. */
function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'fab_sales',
    platform: 'fabric',
    workspaceId: '11111111-2222-3333-4444-555555555555',
    onelakeEndpoint: 'onelake.dfs.fabric.microsoft.com',
    tenantId: '99999999-8888-7777-6666-555555555555',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('fabric props: connector name is delta-lake', () => {
  const props = fabricProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'delta-lake');
});

test('fabric enables the native Azure filesystem with OAUTH auth', () => {
  const props = fabricProvider.catalogProps(src());
  // The enable key is fs.azure.enabled (NOT fs.native-azure.enabled — that is the S3 key).
  assert.equal(props['fs.azure.enabled'], 'true');
  assert.equal(props['azure.auth-type'], 'OAUTH');
  assert.ok(!('fs.native-azure.enabled' in props), 'must not use the S3-style enable key');
});

test('fabric points the Azure endpoint at the OneLake DFS host', () => {
  const props = fabricProvider.catalogProps(src());
  assert.equal(props['azure.endpoint'], 'onelake.dfs.fabric.microsoft.com');
});

// -------------------------------------------- OneLake endpoint normalization ----

test('fabric normalizes a full abfss:// URI down to the DFS host', () => {
  const props = fabricProvider.catalogProps(
    src({
      onelakeEndpoint:
        'abfss://my-workspace@onelake.dfs.fabric.microsoft.com/mylake.lakehouse/Tables/sales',
    } as Partial<WarehouseSource>),
  );
  assert.equal(props['azure.endpoint'], 'onelake.dfs.fabric.microsoft.com');
});

test('fabric normalizes an https:// endpoint down to the host', () => {
  const props = fabricProvider.catalogProps(
    src({
      onelakeEndpoint: 'https://onelake.dfs.fabric.microsoft.com/ws/item.lakehouse',
    } as Partial<WarehouseSource>),
  );
  assert.equal(props['azure.endpoint'], 'onelake.dfs.fabric.microsoft.com');
});

test('fabric accepts the legacy oneLakeUri alias', () => {
  const props = fabricProvider.catalogProps(
    src({
      onelakeEndpoint: undefined,
      oneLakeUri: 'onelake.dfs.fabric.microsoft.com',
    } as Partial<WarehouseSource>),
  );
  assert.equal(props['azure.endpoint'], 'onelake.dfs.fabric.microsoft.com');
});

// ----------------------------- SP creds via ENV only, never inlined --------------

test('fabric references the SP creds via the three ${ENV:AZURE_*} vars', () => {
  const props = fabricProvider.catalogProps(src());
  assert.equal(props['azure.oauth.tenant-id'], '${ENV:AZURE_TENANT_ID}');
  assert.equal(props['azure.oauth.client-id'], '${ENV:AZURE_CLIENT_ID}');
  assert.equal(props['azure.oauth.secret'], '${ENV:AZURE_CLIENT_SECRET}');
});

test('fabric oauth endpoint embeds the tenant via ${ENV:AZURE_TENANT_ID} (no literal tenant)', () => {
  const props = fabricProvider.catalogProps(src());
  assert.equal(
    props['azure.oauth.endpoint'],
    'https://login.microsoftonline.com/${ENV:AZURE_TENANT_ID}/oauth2/v2.0/token',
  );
  // The real tenant GUID from config must NOT be baked into the endpoint.
  assert.ok(!props['azure.oauth.endpoint'].includes('99999999'));
});

test('fabric props NEVER inline a client secret or tenant/client GUID', () => {
  // Even if a raw secret were smuggled through the config, no prop may contain it.
  const props = fabricProvider.catalogProps(
    src({
      // deliberately hostile fields — must not leak into props
      servicePrincipalSecretRef: 'super-secret-client-value-abc123',
      tenantId: '99999999-8888-7777-6666-555555555555',
    } as Partial<WarehouseSource>),
  );
  for (const [k, v] of Object.entries(props)) {
    assert.ok(
      !v.includes('super-secret-client-value-abc123'),
      `${k} must not contain raw secret material`,
    );
    // The concrete tenant GUID must only ever appear via the env-var reference.
    assert.ok(
      !v.includes('99999999-8888-7777-6666-555555555555'),
      `${k} must not inline the tenant GUID`,
    );
  }
  // No access-key / connection-string auth is ever emitted.
  assert.ok(!('azure.access-key' in props));
});

// -------------------------------------------------------------------- guards ----

test('fabric rejects a missing workspaceId', () => {
  assert.throws(
    () => fabricProvider.catalogProps(src({ workspaceId: '' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError && /workspace/i.test((e as Error).message),
  );
});

test('fabric rejects a missing OneLake endpoint', () => {
  assert.throws(
    () =>
      fabricProvider.catalogProps(
        src({ onelakeEndpoint: undefined, oneLakeUri: undefined } as Partial<WarehouseSource>),
      ),
    (e: unknown) => e instanceof WarehouseError && /onelake|endpoint/i.test((e as Error).message),
  );
});

test('fabric rejects an endpoint that is not a fabric DFS host', () => {
  assert.throws(
    () =>
      fabricProvider.catalogProps(
        src({ onelakeEndpoint: 'evil.example.com' } as Partial<WarehouseSource>),
      ),
    (e: unknown) => e instanceof WarehouseError,
  );
});

// ------------------------------------------------------------- secret wiring ----

test('fabric secretMaterial pairs the SP secret with the three Azure env vars', () => {
  assert.deepEqual(fabricProvider.secretMaterial, {
    secretKeys: ['fabric-sp-secret'],
    envVars: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'],
  });
});

// ------------------------------------------------- experimental honesty markers ----

test('fabric is labeled experimental and delta-lake-backed', () => {
  assert.equal(fabricProvider.trinoConnector, 'delta-lake');
  assert.match(fabricProvider.label, /experimental/i);
});

test('fabric test probe is honestly "none" (no native metastore to probe)', () => {
  assert.equal(fabricProvider.testProbe.kind, 'none');
  if (fabricProvider.testProbe.kind === 'none') {
    assert.match(fabricProvider.testProbe.reason, /metastore/i);
  }
});

test('fabric openly declares live verification is required', () => {
  assert.ok(fabricProvider.liveVerificationRequired.length > 0);
  assert.ok(
    fabricProvider.liveVerificationRequired.some((r) => /not a documented/i.test(r)),
    'must state the OneLake Trino path is undocumented',
  );
});
