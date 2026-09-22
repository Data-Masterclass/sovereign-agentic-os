/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snowflakeProvider } from './snowflake.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

/** A well-formed Snowflake source; `override` tweaks one field per test. */
function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'sf_sales',
    platform: 'snowflake',
    accountUrl: 'ACME-PROD',
    database: 'ANALYTICS',
    warehouse: 'WH_XS',
    username: 'SVC_TRINO',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('snowflake props: connector name, database, warehouse, username', () => {
  const props = snowflakeProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'snowflake');
  assert.equal(props['snowflake.database'], 'ANALYTICS');
  assert.equal(props['snowflake.warehouse'], 'WH_XS');
  assert.equal(props['connection-user'], 'SVC_TRINO');
});

test('snowflake maps role only when set', () => {
  assert.ok(!('snowflake.role' in snowflakeProvider.catalogProps(src())));
  const props = snowflakeProvider.catalogProps(src({ role: 'READ_ONLY' } as Partial<WarehouseSource>));
  assert.equal(props['snowflake.role'], 'READ_ONLY');
});

// -------------------------------------------------- connection-url derivation ----

test('snowflake connection-url from a bare account locator', () => {
  const props = snowflakeProvider.catalogProps(src({ accountUrl: 'ACME-PROD' } as Partial<WarehouseSource>));
  assert.equal(props['connection-url'], 'jdbc:snowflake://ACME-PROD.snowflakecomputing.com');
});

test('snowflake connection-url from a full URL (scheme + suffix normalized)', () => {
  const props = snowflakeProvider.catalogProps(
    src({ accountUrl: 'https://ACME-PROD.snowflakecomputing.com' } as Partial<WarehouseSource>),
  );
  assert.equal(props['connection-url'], 'jdbc:snowflake://ACME-PROD.snowflakecomputing.com');
});

test('snowflake connection-url handles org-qualified names and trailing path', () => {
  const props = snowflakeProvider.catalogProps(
    src({ accountUrl: 'https://myorg.acme.snowflakecomputing.com/' } as Partial<WarehouseSource>),
  );
  assert.equal(props['connection-url'], 'jdbc:snowflake://myorg.acme.snowflakecomputing.com');
});

// -------------------------------------------- key-pair secret via ENV, never inlined ----

test('snowflake references the private key via ${ENV:SNOWFLAKE_PRIVATE_KEY}', () => {
  const props = snowflakeProvider.catalogProps(src());
  assert.equal(props['connection-private-key'], '${ENV:SNOWFLAKE_PRIVATE_KEY}');
});

test('snowflake props NEVER inline raw key material (no PEM / BEGIN marker) and no password', () => {
  // Even if a raw PEM were smuggled through the config, no field may contain it.
  const props = snowflakeProvider.catalogProps(
    src({
      accountUrl: 'ACME-PROD',
      // deliberately hostile extra field — must not leak into props
      privateKeySecretRef:
        '-----BEGIN PRIVATE KEY-----MIIEabc-----END PRIVATE KEY-----',
    } as Partial<WarehouseSource>),
  );
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(v), `${k} must not contain a PEM marker`);
    assert.ok(!/-----BEGIN/.test(v), `${k} must not contain raw key material`);
  }
  // No password auth is ever emitted.
  assert.ok(!('connection-password' in props));
});

// -------------------------------------------------------------------- guards ----

test('snowflake rejects a missing account', () => {
  assert.throws(
    () => snowflakeProvider.catalogProps(src({ accountUrl: '' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError && /account/.test((e as Error).message),
  );
});

test('snowflake rejects a missing database', () => {
  assert.throws(
    () => snowflakeProvider.catalogProps(src({ database: '' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError && /database/.test((e as Error).message),
  );
});

test('snowflake rejects a malformed account locator', () => {
  assert.throws(
    () => snowflakeProvider.catalogProps(src({ accountUrl: 'bad account!' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError,
  );
});

// ------------------------------------------------------------- secret wiring ----

test('snowflake secretMaterial pairs the key secret with its env var', () => {
  assert.deepEqual(snowflakeProvider.secretMaterial, {
    secretKeys: ['snowflake-private-key'],
    envVars: ['SNOWFLAKE_PRIVATE_KEY'],
  });
});

test('snowflake test probe is a cheap reachability SHOW SCHEMAS', () => {
  assert.equal(snowflakeProvider.testProbe.kind, 'sql');
  if (snowflakeProvider.testProbe.kind === 'sql') {
    assert.equal(snowflakeProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM sf_sales');
  }
});

// -------------------------------------------------- engine-specific: identifiers ----

test('snowflake identifier rules: upper-cased unquoted, double-quote', () => {
  assert.deepEqual(snowflakeProvider.identifierRules, { quote: '"', unquotedCase: 'upper' });
});

test('snowflake native listing is TERSE, scoped to the UPPER-CASED quoted database', () => {
  assert.equal(snowflakeProvider.discoveryMode, 'terse');
  assert.equal(
    // lower-case input must survive Snowflake's unquoted-upper-casing
    snowflakeProvider.nativeSchemaListing!(src({ database: 'analytics' } as Partial<WarehouseSource>)),
    'SHOW TERSE SCHEMAS IN DATABASE "ANALYTICS"',
  );
});

test('snowflake native listing rejects a missing database', () => {
  assert.throws(
    () => snowflakeProvider.nativeSchemaListing!(src({ database: '' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError && /database/.test((e as Error).message),
  );
});

// -------------------------------------------------- engine-specific: type handling ----

test('snowflake VARIANT/OBJECT/ARRAY map to json, GEOGRAPHY to varchar on import', () => {
  const rules = snowflakeProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('variant')!.castTo, 'json');
  assert.equal(hit('object')!.castTo, 'json');
  assert.equal(hit('array')!.castTo, 'json');
  assert.equal(hit('geography')!.castTo, 'varchar');
  // a plain scalar has no rule → passes through unchanged
  assert.equal(hit('number'), undefined);
});

test('snowflake notes call out unquoted upper-casing + warehouse credit cost', () => {
  const joined = (snowflakeProvider.notes ?? []).join(' ');
  assert.ok(/UPPER-CASED/.test(joined), 'flags identifier casing');
  assert.ok(/credit|AUTO-RESUME/i.test(joined), 'flags warehouse cost');
});
