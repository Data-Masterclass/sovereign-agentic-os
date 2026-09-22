/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlServerProvider } from './sqlserver.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'mssql_erp',
    platform: 'sqlserver',
    host: 'sql.internal',
    database: 'erp',
    username: 'ro_user',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('sqlserver props: connector name, jdbc url with databaseName, user, case-insensitive', () => {
  const props = sqlServerProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'sqlserver');
  assert.equal(props['connection-url'], 'jdbc:sqlserver://sql.internal:1433;databaseName=erp');
  assert.equal(props['connection-user'], 'ro_user');
  assert.equal(props['case-insensitive-name-matching'], 'true');
});

test('sqlserver honours an explicit port and never forces encrypt=false', () => {
  const props = sqlServerProvider.catalogProps(src({ port: '1440' } as Partial<WarehouseSource>));
  assert.equal(props['connection-url'], 'jdbc:sqlserver://sql.internal:1440;databaseName=erp');
  // Must NOT downgrade TLS by forcing encrypt=false.
  assert.ok(!/encrypt=false/i.test(props['connection-url']));
});

// -------------------------------------------- password via ENV, never inlined ----

test('sqlserver references the password via ${ENV:SQLSERVER_PASSWORD}, never a raw value', () => {
  const props = sqlServerProvider.catalogProps(
    src({ passwordSecretRef: 'p@ssw0rd-raw-secret' } as Partial<WarehouseSource>),
  );
  assert.equal(props['connection-password'], '${ENV:SQLSERVER_PASSWORD}');
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/p@ssw0rd/.test(v), `${k} must not contain the raw password`);
  }
});

test('sqlserver secretMaterial pairs the password with its env var', () => {
  assert.deepEqual(sqlServerProvider.secretMaterial, {
    secretKeys: ['sqlserver-password'],
    envVars: ['SQLSERVER_PASSWORD'],
  });
});

// -------------------------------------------------------------------- guards ----

test('sqlserver rejects a missing host, database, username; and an injection-y database', () => {
  assert.throws(() => sqlServerProvider.catalogProps(src({ host: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => sqlServerProvider.catalogProps(src({ database: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => sqlServerProvider.catalogProps(src({ username: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(
    () => sqlServerProvider.catalogProps(src({ database: 'erp;user=sa' } as Partial<WarehouseSource>)),
    WarehouseError,
  );
});

// -------------------------------------------------- engine-specific: identifiers ----

test('sqlserver identifier rules: bracket quote, collation-driven casing (preserve)', () => {
  assert.deepEqual(sqlServerProvider.identifierRules, { quote: '[', unquotedCase: 'preserve' });
  assert.equal(sqlServerProvider.discoveryMode, 'show');
});

// -------------------------------------------------- engine-specific: type handling ----

test('sqlserver uniqueidentifier/money/xml → varchar, image → varbinary', () => {
  const rules = sqlServerProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('uniqueidentifier')!.castTo, 'varchar');
  assert.equal(hit('money')!.castTo, 'varchar');
  assert.equal(hit('smallmoney')!.castTo, 'varchar');
  assert.equal(hit('xml')!.castTo, 'varchar');
  assert.equal(hit('image')!.castTo, 'varbinary');
  // datetime2 / nvarchar pass through — Trino maps them faithfully.
  assert.equal(hit('datetime2'), undefined);
  assert.equal(hit('nvarchar'), undefined);
});

test('sqlserver notes flag single-database pin, collation casing, snapshot isolation', () => {
  const joined = (sqlServerProvider.notes ?? []).join(' ');
  assert.ok(/databaseName=/.test(joined), 'flags single-database pin');
  assert.ok(/COLLATION/i.test(joined), 'flags collation casing');
  assert.ok(/SNAPSHOT/i.test(joined), 'flags snapshot isolation');
});

test('sqlserver test probe is a cheap reachability SHOW SCHEMAS', () => {
  assert.equal(sqlServerProvider.testProbe.kind, 'sql');
  if (sqlServerProvider.testProbe.kind === 'sql') {
    assert.equal(sqlServerProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM mssql_erp');
  }
});
