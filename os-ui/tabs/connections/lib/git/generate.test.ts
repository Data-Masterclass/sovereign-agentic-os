/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — a warehouse connection is a Trino catalog file in the domain repo
 * USER STORY: As an engineer who clones my domain's repository I want each federated connection
 *             as `connections/<catalog>/catalog.properties` in Trino's own format (secrets only as
 *             `${ENV:…}` references) plus an `os.yaml` with the OS-only facts, so that a plain
 *             Trino can load the catalog with no OS present (design 11 A10, design 12).
 * ARCHITECTURE: node:test against the real module (and a real temp git repo where it commits); no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTIONS_PREFIX,
  assertNoLiteralSecrets,
  generateConnectionFiles,
  parseCatalogProperties,
  renderCatalogProperties,
  type SnapshotConnection,
} from '@tabs/connections/lib/git/generate';

function pg(over: Partial<SnapshotConnection> = {}): SnapshotConnection {
  return {
    id: 'conn_pg1',
    name: 'Sales Postgres',
    template: 'warehouse',
    owner: 'alex@example.com',
    domain: 'sales',
    visibility: 'domain',
    archived: false,
    secretRef: { name: 'conn-conn_pg1', key: 'password' },
    warehouse: { platform: 'postgresql', catalog: 'pg_sales', config: { host: 'db.internal', port: '5432', database: 'sales', username: 'reader' } },
    ...over,
  };
}

test('a warehouse connection becomes connections/<catalog>/catalog.properties + os.yaml + README', () => {
  const files = generateConnectionFiles('sales', [pg()]);
  assert.deepEqual([...files.keys()].sort(), [
    'connections/README.md',
    'connections/pg_sales/README.md',
    'connections/pg_sales/catalog.properties',
    'connections/pg_sales/os.yaml',
  ]);
  for (const p of files.keys()) assert.ok(p.startsWith(CONNECTIONS_PREFIX), p);
  const props = parseCatalogProperties(files.get('connections/pg_sales/catalog.properties')!);
  assert.equal(props['connector.name'], 'postgresql');
  assert.equal(props['connection-url'], 'jdbc:postgresql://db.internal:5432/sales');
  assert.equal(props['connection-user'], 'reader');
  // The secret is a Trino env reference, never a value.
  assert.equal(props['connection-password'], '${ENV:POSTGRESQL_PASSWORD}');
});

test('os.yaml carries the OS layer and names the secret only by reference', () => {
  const os = generateConnectionFiles('sales', [pg()]).get('connections/pg_sales/os.yaml')!;
  assert.match(os, /^id: conn_pg1$/m);
  assert.match(os, /^owner: alex@example.com$/m);
  assert.match(os, /^scope: domain$/m);
  assert.match(os, /name: conn-conn_pg1/);
  assert.match(os, /POSTGRESQL_PASSWORD/);
  // Nothing in os.yaml is a Trino property: the native file stands on its own.
  assert.doesNotMatch(os, /connector\.name|connection-url/);
});

test('only live warehouse connections of THIS domain are emitted', () => {
  const files = generateConnectionFiles('sales', [
    pg(),
    pg({ id: 'c2', archived: true, warehouse: { platform: 'postgresql', catalog: 'pg_old', config: { host: 'h', database: 'd', username: 'u' } } }),
    pg({ id: 'c3', domain: 'finance', warehouse: { platform: 'postgresql', catalog: 'pg_fin', config: { host: 'h', database: 'd', username: 'u' } } }),
    pg({ id: 'c4', template: 'gdrive', warehouse: undefined }),
  ]);
  const dirs = [...files.keys()].filter((p) => p.endsWith('/catalog.properties'));
  assert.deepEqual(dirs, ['connections/pg_sales/catalog.properties']);
});

test('the output is deterministic (sorted keys, no timestamps)', () => {
  const a = generateConnectionFiles('sales', [pg()]);
  const b = generateConnectionFiles('sales', [pg()]);
  assert.deepEqual([...a.entries()], [...b.entries()]);
  const body = a.get('connections/pg_sales/catalog.properties')!.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(body, [...body].sort());
});

test('render → parse round-trips every property byte for byte', () => {
  const props = { 'connector.name': 'postgresql', 'connection-url': 'jdbc:postgresql://h:5432/d?sslmode=require', 'connection-password': '${ENV:X}' };
  assert.deepEqual(parseCatalogProperties(renderCatalogProperties(props, 'c')), props);
});

test('NEGATIVE: a literal secret is refused before it can reach git', () => {
  assert.throws(() => assertNoLiteralSecrets({ 'connector.name': 'postgresql', 'connection-password': 'hunter2' }), /literal secret/);
  assert.throws(() => assertNoLiteralSecrets({ 'unity.token': 'dapi123' }), /literal secret/);
  assert.throws(() => assertNoLiteralSecrets({ 'connection-url': 'jdbc:postgresql://u:pw@h/d' }), /credentials inside/);
  assert.throws(() => assertNoLiteralSecrets({ 'mongodb.connection-url': 'mongodb://u:pw@h' }), /credentials inside|literal secret/);
  // A reference is fine.
  assertNoLiteralSecrets({ 'connection-password': '${ENV:POSTGRESQL_PASSWORD}', 'mongodb.connection-url': '${ENV:MONGODB_CONNECTION_URL}' });
});

test('NEGATIVE: a connection whose config cannot render is refused, never silently skipped', () => {
  assert.throws(
    () => generateConnectionFiles('sales', [pg({ warehouse: { platform: 'postgresql', catalog: 'pg_sales', config: { host: '', database: 'd', username: 'u' } } })]),
    /pg_sales/,
  );
});
