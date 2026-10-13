/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Catalog snapshot build + diff + honest status (lakehouse Expose, Phase 1). Discovery is
 * INJECTED so the SHOW SCHEMAS / SHOW TABLES loop is driven without a cluster; the mirror
 * is offline (in-memory registry authoritative).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

globalThis.fetch = (async () => {
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, __resetConnections } = await import('./store.ts');
const { refreshCatalogSnapshot, getCatalogSnapshot, describeTable, __resetCatalogSnapshots } = await import('./warehouse/catalog-snapshot.ts');

const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };

async function glueConn() {
  return createConnection(admin, {
    name: 'Glue sales', template: 'warehouse', endpoint: '', credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
}

/** A discovery mock: top call returns schemas; per-schema call returns that schema's tables. */
function mockDiscover(map: Record<string, string[]>) {
  return async (_id: string, _user: unknown, opts: { schema?: string }) => {
    if (!opts.schema) return { ok: true, schemas: Object.keys(map), tables: [] };
    return { ok: true, schemas: [], tables: map[opts.schema] ?? [] };
  };
}

function reset() { __resetConnections(); __resetCatalogSnapshots(); }

test('build loops SHOW SCHEMAS + per-schema SHOW TABLES into a sorted, live snapshot', async () => {
  reset();
  const c = await glueConn();
  const snap = await refreshCatalogSnapshot(c.id, admin, {
    discover: mockDiscover({ public: ['orders', 'customers'], staging: ['raw_events'] }),
  });
  assert.equal(snap.status, 'live');
  assert.equal(snap.catalog, 'glue_sales');
  assert.deepEqual(snap.tables, [
    { schema: 'public', table: 'customers' },
    { schema: 'public', table: 'orders' },
    { schema: 'staging', table: 'raw_events' },
  ]);
  assert.deepEqual(snap.prevDiff, { added: snap.tables, removed: [] }); // first snapshot
});

test('a second snapshot diffs against the first (added/removed tables)', async () => {
  reset();
  const c = await glueConn();
  await refreshCatalogSnapshot(c.id, admin, { discover: mockDiscover({ public: ['orders', 'customers'] }) });
  const snap2 = await refreshCatalogSnapshot(c.id, admin, { discover: mockDiscover({ public: ['orders', 'refunds'] }) });
  assert.deepEqual(snap2.prevDiff.added, [{ schema: 'public', table: 'refunds' }]);
  assert.deepEqual(snap2.prevDiff.removed, [{ schema: 'public', table: 'customers' }]);
});

test('an unreachable catalog → honest unreachable snapshot, empty tables (never fabricated)', async () => {
  reset();
  const c = await glueConn();
  const snap = await refreshCatalogSnapshot(c.id, admin, {
    discover: async () => ({ ok: false, schemas: [], tables: [] }),
  });
  assert.equal(snap.status, 'unreachable');
  assert.deepEqual(snap.tables, []);
});

test('getCatalogSnapshot returns the cached snapshot as stale (not re-discovered)', async () => {
  reset();
  const c = await glueConn();
  await refreshCatalogSnapshot(c.id, admin, { discover: mockDiscover({ public: ['orders'] }) });
  const cached = await getCatalogSnapshot(c.id, admin);
  assert.ok(cached);
  assert.equal(cached!.status, 'stale'); // a read-back is honestly stale
  assert.equal(cached!.tables.length, 1);
});

test('getCatalogSnapshot is null before any snapshot is taken', async () => {
  reset();
  const c = await glueConn();
  assert.equal(await getCatalogSnapshot(c.id, admin), null);
});

/** A DESCRIBE mock: Trino returns Column, Type, Extra, Comment per row. */
function describeResult(rows: string[][]) {
  return async () => ({ engine: 'trino', tables: [], columns: ['Column', 'Type', 'Extra', 'Comment'], rows, rowCount: rows.length });
}

test('describeTable returns name + type + the Comment column (additively)', async () => {
  reset();
  const c = await glueConn();
  const cols = await describeTable(c.id, admin, { schema: 'public', table: 'orders' }, {
    query: describeResult([
      ['order_id', 'bigint', '', 'Primary key'],
      ['total', 'double', '', 'Order total in EUR'],
    ]),
  });
  assert.deepEqual(cols, [
    { name: 'order_id', type: 'bigint', comment: 'Primary key' },
    { name: 'total', type: 'double', comment: 'Order total in EUR' },
  ]);
});

test('describeTable omits an absent/blank comment (never fabricated)', async () => {
  reset();
  const c = await glueConn();
  const cols = await describeTable(c.id, admin, { schema: 'public', table: 'orders' }, {
    query: describeResult([
      ['order_id', 'bigint', '', ''],      // blank comment → omitted
      ['sku', 'varchar'],                   // metastore didn't even return a Comment column
    ]),
  });
  assert.deepEqual(cols, [
    { name: 'order_id', type: 'bigint' },
    { name: 'sku', type: 'varchar' },
  ]);
  assert.ok(!('comment' in cols[0]));
});

test('describeTable rejects a non-identifier schema/table (SQL-injection guard)', async () => {
  reset();
  const c = await glueConn();
  await assert.rejects(
    describeTable(c.id, admin, { schema: 'public"; DROP', table: 'orders' }, { query: describeResult([]) }),
    /Invalid schema\/table identifier/,
  );
});

// -------------------------------------------- operational dispatch (Phase 0/1) ----

async function salesforceConn() {
  return createConnection(admin, {
    name: 'Salesforce prod', template: 'salesforce-api',
    endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs',
  });
}

test('operational snapshot dispatches through the registry — honest unreachable offline (never fabricated)', async () => {
  reset();
  const c = await salesforceConn();
  // No discover injection: the registry path calls the REAL Salesforce discover, which is
  // offline (fetch stub throws) → an honest 'unreachable' snapshot, empty tables, real
  // pseudo-catalog. This proves the dispatch routed to the operational path, not warehouse.
  const snap = await refreshCatalogSnapshot(c.id, admin);
  assert.equal(snap.catalog, 'salesforce'); // the operational pseudo-catalog
  assert.equal(snap.status, 'unreachable');
  assert.deepEqual(snap.tables, []); // nothing invented when the source is unreachable
});
