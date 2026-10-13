/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlProvider } from './mysql.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'mysql_shop',
    platform: 'mysql',
    host: 'mysql.internal',
    username: 'ro_user',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('mysql props: connector name, jdbc url (NO database), user, case-insensitive', () => {
  const props = mysqlProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'mysql');
  // MySQL exposes every database as a schema — no database in the URL.
  assert.equal(props['connection-url'], 'jdbc:mysql://mysql.internal:3306');
  assert.equal(props['connection-user'], 'ro_user');
  assert.equal(props['case-insensitive-name-matching'], 'true');
});

test('mysql honours an explicit port and a host:port host', () => {
  assert.equal(
    mysqlProvider.catalogProps(src({ port: '3307' } as Partial<WarehouseSource>))['connection-url'],
    'jdbc:mysql://mysql.internal:3307',
  );
  assert.equal(
    mysqlProvider.catalogProps(src({ host: 'mysql.internal:3399' } as Partial<WarehouseSource>))['connection-url'],
    'jdbc:mysql://mysql.internal:3399',
  );
});

// -------------------------------------------- password via ENV, never inlined ----

test('mysql references the password via ${ENV:MYSQL_PASSWORD}, never a raw value', () => {
  const props = mysqlProvider.catalogProps(
    src({ passwordSecretRef: 'letmein-raw-secret' } as Partial<WarehouseSource>),
  );
  assert.equal(props['connection-password'], '${ENV:MYSQL_PASSWORD}');
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/letmein/.test(v), `${k} must not contain the raw password`);
  }
});

test('mysql secretMaterial pairs the password with its env var', () => {
  assert.deepEqual(mysqlProvider.secretMaterial, {
    secretKeys: ['mysql-password'],
    envVars: ['MYSQL_PASSWORD'],
  });
});

// -------------------------------------------------------------------- guards ----

test('mysql rejects a missing host and username (mysql-labeled error)', () => {
  assert.throws(
    () => mysqlProvider.catalogProps(src({ host: '' } as Partial<WarehouseSource>)),
    (e: unknown) => e instanceof WarehouseError && /mysql/.test((e as Error).message),
  );
  assert.throws(() => mysqlProvider.catalogProps(src({ username: '' } as Partial<WarehouseSource>)), WarehouseError);
});

// -------------------------------------------------- engine-specific: identifiers ----

test('mysql identifier rules: backtick quote, OS-dependent casing matched as lower', () => {
  assert.deepEqual(mysqlProvider.identifierRules, { quote: '`', unquotedCase: 'lower' });
  assert.equal(mysqlProvider.discoveryMode, 'show');
});

test('mysql discoverTables validates the schema', () => {
  assert.equal(mysqlProvider.discoverTables!(src(), 'shop'), 'SHOW TABLES FROM mysql_shop.shop');
  assert.throws(() => mysqlProvider.discoverTables!(src(), 'bad-schema!'), WarehouseError);
});

// -------------------------------------------------- engine-specific: type handling ----

test('mysql json → json, set → varchar, scalars pass through', () => {
  const rules = mysqlProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('json')!.castTo, 'json');
  assert.equal(hit('set')!.castTo, 'varchar');
  assert.equal(hit('int'), undefined);
  assert.equal(hit('datetime'), undefined);
});

test('mysql notes flag OS-dependent casing + text pushdown', () => {
  const joined = (mysqlProvider.notes ?? []).join(' ');
  assert.ok(/OS-dependent/i.test(joined), 'flags OS-dependent casing');
  assert.ok(/PUSHDOWN/i.test(joined), 'flags pushdown cost');
});

test('mysql test probe is a cheap reachability SHOW SCHEMAS', () => {
  assert.equal(mysqlProvider.testProbe.kind, 'sql');
  if (mysqlProvider.testProbe.kind === 'sql') {
    assert.equal(mysqlProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM mysql_shop');
  }
});
