/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresProvider, jdbcAuthority } from '@tabs/connections/lib/warehouse/providers/postgres';
import { WarehouseError, type WarehouseSource } from '@tabs/connections/lib/warehouse/types';

/** A well-formed PostgreSQL source; `override` tweaks one field per test. */
function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'pg_orders',
    platform: 'postgresql',
    host: 'db.internal',
    database: 'orders',
    username: 'ro_user',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('postgres props: connector name, jdbc url, user, case-insensitive matching', () => {
  const props = postgresProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'postgresql');
  assert.equal(props['connection-url'], 'jdbc:postgresql://db.internal:5432/orders');
  assert.equal(props['connection-user'], 'ro_user');
  assert.equal(props['case-insensitive-name-matching'], 'true');
});

test('postgres honours an explicit port and a host:port host', () => {
  assert.equal(
    postgresProvider.catalogProps(src({ port: '6543' } as Partial<WarehouseSource>))['connection-url'],
    'jdbc:postgresql://db.internal:6543/orders',
  );
  assert.equal(
    postgresProvider.catalogProps(src({ host: 'db.internal:7000' } as Partial<WarehouseSource>))['connection-url'],
    'jdbc:postgresql://db.internal:7000/orders',
  );
});

// -------------------------------------------- password via ENV, never inlined ----

test('postgres references the password via ${ENV:POSTGRESQL_PASSWORD}, never a raw value', () => {
  const props = postgresProvider.catalogProps(
    src({ passwordSecretRef: 'hunter2-super-secret' } as Partial<WarehouseSource>),
  );
  assert.equal(props['connection-password'], '${ENV:POSTGRESQL_PASSWORD}');
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/hunter2/.test(v), `${k} must not contain the raw password`);
  }
});

test('postgres secretMaterial pairs the password with its env var (secretKeys[i] ↔ envVars[i])', () => {
  assert.deepEqual(postgresProvider.secretMaterial, {
    secretKeys: ['postgresql-password'],
    envVars: ['POSTGRESQL_PASSWORD'],
  });
});

// -------------------------------------------------------------------- guards ----

test('postgres rejects a missing host, database, and username', () => {
  assert.throws(() => postgresProvider.catalogProps(src({ host: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => postgresProvider.catalogProps(src({ database: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => postgresProvider.catalogProps(src({ username: '' } as Partial<WarehouseSource>)), WarehouseError);
});

test('postgres rejects an injection-y database name', () => {
  assert.throws(
    () => postgresProvider.catalogProps(src({ database: 'orders?ssl=off' } as Partial<WarehouseSource>)),
    WarehouseError,
  );
});

// -------------------------------------------------- shared jdbcAuthority helper ----

test('jdbcAuthority applies the default port and strips a pasted scheme', () => {
  assert.equal(jdbcAuthority('db.internal', undefined, 5432), 'db.internal:5432');
  assert.equal(jdbcAuthority('jdbc:postgresql://db.internal/x', undefined, 5432), 'db.internal:5432');
});

test('jdbcAuthority rejects a bad host and a non-numeric port', () => {
  assert.throws(() => jdbcAuthority('bad host!', undefined, 5432), WarehouseError);
  assert.throws(() => jdbcAuthority('db.internal', 'abc', 5432), WarehouseError);
});

// -------------------------------------------------- engine-specific: identifiers ----

test('postgres identifier rules: lower-cased unquoted, double-quote', () => {
  assert.deepEqual(postgresProvider.identifierRules, { quote: '"', unquotedCase: 'lower' });
  assert.equal(postgresProvider.discoveryMode, 'show');
});

test('postgres discoverTables validates the schema and is injection-safe', () => {
  assert.equal(postgresProvider.discoverTables!(src(), 'public'), 'SHOW TABLES FROM pg_orders.public');
  assert.throws(() => postgresProvider.discoverTables!(src(), 'bad schema!'), WarehouseError);
});

// -------------------------------------------------- engine-specific: type handling ----

test('postgres json/jsonb → json, uuid → varchar, hstore → json, array → json', () => {
  const rules = postgresProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('json')!.castTo, 'json');
  assert.equal(hit('jsonb')!.castTo, 'json');
  assert.equal(hit('uuid')!.castTo, 'varchar');
  assert.equal(hit('hstore')!.castTo, 'json');
  assert.equal(hit('integer[]')!.castTo, 'json');
  assert.equal(hit('integer'), undefined); // a plain scalar passes through
});

test('postgres notes call out schema mapping, lower-casing and text pushdown cost', () => {
  const joined = (postgresProvider.notes ?? []).join(' ');
  assert.ok(/LOWER-CASED/.test(joined), 'flags identifier casing');
  assert.ok(/PUSHDOWN/i.test(joined), 'flags pushdown cost');
});

test('postgres test probe is a cheap reachability SHOW SCHEMAS', () => {
  assert.equal(postgresProvider.testProbe.kind, 'sql');
  if (postgresProvider.testProbe.kind === 'sql') {
    assert.equal(postgresProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM pg_orders');
  }
});

/* ----------------------------------------------------------------- TLS mode */

/** Managed PostgreSQL rejects plaintext, so this is the difference between a
 *  catalog that registers and one that cannot connect at all. */
test('PG-TLS: sslmode lands on the connection URL', () => {
  const props = postgresProvider.catalogProps({
    catalog: 'pg_x', platform: 'postgresql',
    host: 'db.abc.supabase.co', database: 'postgres', username: 'os_reader',
    sslmode: 'require',
  } as never);
  assert.equal(props['connection-url'], 'jdbc:postgresql://db.abc.supabase.co:5432/postgres?sslmode=require');
});

test('PG-TLS: omitted leaves the URL exactly as before (in-cluster default)', () => {
  const props = postgresProvider.catalogProps({
    catalog: 'pg_x', platform: 'postgresql',
    host: 'pg-rw', database: 'litellm', username: 'u',
  } as never);
  assert.equal(props['connection-url'], 'jdbc:postgresql://pg-rw:5432/litellm');
});

test('PG-TLS: every libpq mode is accepted', () => {
  for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']) {
    const props = postgresProvider.catalogProps({
      catalog: 'pg_x', platform: 'postgresql', host: 'h', database: 'd', username: 'u', sslmode: mode,
    } as never);
    assert.match(String(props['connection-url']), new RegExp(`\\?sslmode=${mode}$`));
  }
});

test('PG-TLS: an unknown mode is REFUSED, not interpolated', () => {
  assert.throws(
    () => postgresProvider.catalogProps({
      catalog: 'pg_x', platform: 'postgresql', host: 'h', database: 'd', username: 'u',
      sslmode: 'require&ssl=false',
    } as never),
    /unsupported sslmode/,
  );
});

test('PG-TLS: the TLS field is offered in the editor, and is optional', () => {
  const f = postgresProvider.credentialFields.find((x) => x.key === 'sslmode');
  assert.ok(f, 'the editor must be able to set sslmode');
  assert.equal(f.required, false);
  assert.equal(f.kind, 'text');
});

test('PG-TLS: the password is still never in the props', () => {
  const props = postgresProvider.catalogProps({
    catalog: 'pg_x', platform: 'postgresql', host: 'h', database: 'd', username: 'u', sslmode: 'require',
  } as never);
  assert.equal(JSON.stringify(props).includes('secret'), false);
  assert.match(String(props['connection-password']), /^\$\{ENV:/);
});
