/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * P0 A2 — `importWarehouseTable` must create a governed Dataset row (Bronze lit,
 * pointing at the materialized table) and return its id — not just run a CTAS and
 * vanish. Offline-stubs fetch EXCEPT the query-tool `/execute` seam, which is
 * faked so the governed-write call (SQL shape, principal, target) is observable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

// Force external connectors ON for this suite (createConnection gates on it).
(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

const _realFetch = globalThis.fetch;
type ExecCall = { sql: string; principal: string; uid: string };
const execCalls: ExecCall[] = [];
let execOutcome: 'ok' | 'fail' = 'ok';

globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  if (String(url).includes('/execute')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as ExecCall;
    execCalls.push(body);
    if (execOutcome === 'fail') return new Response(JSON.stringify({ error: 'TABLE_NOT_FOUND: boom' }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, rowsAffected: 2 }), { status: 200 });
  }
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, importWarehouseTable, __resetConnections } = await import('./store.ts');
const { getDataset, listDatasets, __resetStore } = await import('@/lib/data/store');

const builder = { id: 'b1', name: 'B', domains: ['sales'], role: 'builder' as const };

async function glueConn() {
  return createConnection(builder, {
    name: 'Glue sales',
    template: 'warehouse',
    endpoint: '',
    credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
}

test('import creates a governed Dataset row: Bronze lit, personal-lane target, datasetId returned', async () => {
  __resetConnections();
  __resetStore();
  execCalls.length = 0;
  execOutcome = 'ok';
  const c = await glueConn();

  const out = await importWarehouseTable(c.id, builder, {
    schema: 'raw', table: 'orders', name: 'Imported warehouse orders', targetDomain: 'sales',
  });

  // The registry row exists, is owned by the caller, and its Bronze dot is lit.
  assert.ok(out.datasetId, 'the import returns the new datasetId');
  const d = getDataset(out.datasetId, builder);
  assert.equal(d.name, 'Imported warehouse orders');
  assert.equal(d.owner, 'b1');
  assert.equal(d.versions.bronze.built, true, 'Bronze registered after the landing');

  // The CTAS landed at the row's CANONICAL personal-lane Bronze target, in the ONLY
  // shape the query-tool write allowlist admits, run AS the uid (owner rule).
  assert.equal(out.target, 'iceberg.personal_b1.bronze_imported_warehouse_orders');
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0].sql, /^CREATE OR REPLACE TABLE iceberg\.personal_b1\.bronze_imported_warehouse_orders AS SELECT \* FROM glue_sales\.raw\.orders$/);
  assert.equal(execCalls[0].principal, 'b1', 'personal-lane write runs AS the uid');
  assert.equal(out.rowsAffected, 2);
});

test('a failed CTAS registers NOTHING — no phantom dataset row left behind', async () => {
  __resetConnections();
  __resetStore();
  execCalls.length = 0;
  execOutcome = 'fail';
  const c = await glueConn();

  await assert.rejects(
    () => importWarehouseTable(c.id, builder, { schema: 'raw', table: 'orders', name: 'Doomed import' }),
    /TABLE_NOT_FOUND/,
  );
  const mine = listDatasets(builder).mine.map((d) => d.name);
  assert.ok(!mine.includes('Doomed import'), 'the fresh registry row was cleaned up');
});

test('a duplicate dataset name is an honest 409 BEFORE any physical write', async () => {
  __resetConnections();
  __resetStore();
  execCalls.length = 0;
  execOutcome = 'ok';
  const c = await glueConn();
  await importWarehouseTable(c.id, builder, { schema: 'raw', table: 'orders', name: 'Once only' });
  execCalls.length = 0;

  await assert.rejects(
    () => importWarehouseTable(c.id, builder, { schema: 'raw', table: 'orders', name: 'Once only' }),
    (e: Error & { status?: number }) => e.status === 409,
  );
  assert.equal(execCalls.length, 0, 'no CTAS was attempted for the duplicate');
});

test.after(() => {
  globalThis.fetch = _realFetch;
});
