/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MCP parity for the lakehouse expose/adopt journey (lakehouse Phase 4). Driven exactly as an
 * AI client would — over `handleRpc` / `tools/call` — with the REAL governed stores
 * (connections, exposures, catalog snapshot, exposed-tables, datasets). We prove the FRONT-DOOR
 * INVARIANT: each tool runs the SAME lib the UI does, with the SAME gates + honest outputs:
 *   • exposure CRUD is admin-gated (a builder is refused); create compiles + lists;
 *   • revoke propagates (frozen dataset count) exactly as the route does;
 *   • get_catalog_snapshot reads the cached listing; refresh is admin-gated;
 *   • classify_catalog is admin-gated + errors honestly without a taxonomy seed;
 *   • list_exposed_tables is domain-scoped; adopt_exposed_table floors at domain_admin,
 *     validates the table is exposed, requires a description, and creates a connected dataset;
 *   • get_dataset surfaces the `connected` block on an adopted dataset.
 * Offline: the OpenSearch mirror + trace + query tool are unreachable (graceful no-ops).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('./server.ts');
type JsonRpcResponse = import('./server.ts').JsonRpcResponse;
type ToolError = import('./server.ts').ToolError;
const { createConnection, __resetConnections } = await import('@/lib/connections/store');
const { __resetExposures } = await import('@/lib/connections/exposures');
const { refreshCatalogSnapshot, __resetCatalogSnapshots } = await import('@/lib/connections/warehouse/catalog-snapshot');
const { setSeed, __resetCatalogClassifications } = await import('@/lib/connections/warehouse/catalog-classification');
const { __resetStore: resetData } = await import('@/lib/data/store');

// A platform admin (exposure CRUD, catalog refresh/classify) + a domain admin who shares the
// exposed domain (adopt) + a builder (denied the admin acts).
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };
const dadmin: CurrentUser = { id: 'dan', name: 'Dan', domains: ['commerce'], role: 'domain_admin' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])?.[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}
function mockDiscover(map: Record<string, string[]>) {
  return async (_id: string, _user: unknown, opts: { schema?: string }) => {
    if (!opts.schema) return { ok: true, schemas: Object.keys(map), tables: [] };
    return { ok: true, schemas: [], tables: map[opts.schema] ?? [] };
  };
}

/** Fresh world: a warehouse connection with a cached snapshot of two tables. */
async function seed(): Promise<{ connId: string }> {
  __resetConnections(); __resetExposures(); __resetCatalogSnapshots(); __resetCatalogClassifications(); resetData();
  const c = await createConnection(admin, {
    name: 'Glue sales', template: 'warehouse', endpoint: '', credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
  await refreshCatalogSnapshot(c.id, admin, { discover: mockDiscover({ sales: ['orders', 'customers'] }) });
  return { connId: c.id };
}

test('get_catalog_snapshot reads the cached listing', async () => {
  const { connId } = await seed();
  const p = payload<{ snapshot: { tables: { schema: string; table: string }[] } | null }>(await call(admin, 'get_catalog_snapshot', { connId }));
  assert.ok(p.snapshot);
  assert.equal(p.snapshot!.tables.length, 2);
});

test('create_exposure_set is admin-gated — a builder is refused', async () => {
  const { connId } = await seed();
  const err = errorOf(await call(builder, 'create_exposure_set', { connId, name: 'x', domains: ['commerce'], tables: [{ schema: 'sales', table: 'orders' }] }));
  assert.equal(err.code, 'forbidden');
});

test('admin creates an exposure set; it lists', async () => {
  const { connId } = await seed();
  const created = payload<{ exposure: { id: string; domains: string[] } }>(
    await call(admin, 'create_exposure_set', { connId, name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'gold', tables: [{ schema: 'sales', table: 'orders' }] }),
  );
  assert.deepEqual(created.exposure.domains, ['commerce']);
  const listed = payload<{ exposures: { id: string }[] }>(await call(admin, 'list_exposure_sets', { connId }));
  assert.equal(listed.exposures.length, 1);
});

test('refresh_connection_catalog is admin-gated — a builder is refused', async () => {
  const { connId } = await seed();
  const err = errorOf(await call(builder, 'refresh_connection_catalog', { connId }));
  assert.equal(err.code, 'forbidden');
});

test('classify_catalog is admin-gated + errors honestly without a taxonomy seed', async () => {
  const { connId } = await seed();
  assert.equal(errorOf(await call(builder, 'classify_catalog', { connId })).code, 'forbidden');
  // No seed chosen yet → an honest error, not a fabricated tally.
  const err = errorOf(await call(admin, 'classify_catalog', { connId }));
  assert.match(err.reason, /folders are organized|organize/i);
});

test('get_catalog_classification returns counts + placements (domain-visible read)', async () => {
  const { connId } = await seed();
  await setSeed(connId, admin, 'starter');
  const p = payload<{ counts: Record<string, number>; placements: Record<string, unknown>; taxonomy: unknown[] }>(
    await call(admin, 'get_catalog_classification', { connId }),
  );
  assert.ok(Array.isArray(p.taxonomy));
  // No AI run yet → both tables resolve to Unsorted.
  assert.equal(p.counts.unsorted, 2);
});

test('list_exposed_tables is domain-scoped; adopt floors at domain_admin + validates + creates', async () => {
  const { connId } = await seed();
  await call(admin, 'create_exposure_set', { connId, name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'gold', tables: [{ schema: 'sales', table: 'orders' }] });

  // The domain admin (commerce) sees the exposure; the platform admin (sales) does not.
  const dSees = payload<{ connections: { exposures: { exposureId: string; tables: { schema: string; table: string }[] }[] }[] }>(await call(dadmin, 'list_exposed_tables'));
  assert.equal(dSees.connections.length, 1);
  const exposureId = dSees.connections[0].exposures[0].exposureId;
  const aSees = payload<{ connections: unknown[] }>(await call(admin, 'list_exposed_tables'));
  assert.equal(aSees.connections.length, 0);

  // A builder cannot adopt (floor is domain_admin) — refused at the visibility gate.
  assert.equal(errorOf(await call(builder, 'adopt_exposed_table', { exposureId, schema: 'sales', table: 'orders', description: 'x' })).code, 'forbidden');
  // A missing description is refused.
  assert.equal(errorOf(await call(dadmin, 'adopt_exposed_table', { exposureId, schema: 'sales', table: 'orders', description: '' })).code, 'bad_request');
  // A table not in the exposure is refused.
  assert.equal(errorOf(await call(dadmin, 'adopt_exposed_table', { exposureId, schema: 'sales', table: 'ghost', description: 'x' })).code, 'bad_request');

  // A valid adopt creates a connected dataset; get_dataset shows its connected block.
  const adopted = payload<{ dataset: { id: string; origin: string } }>(
    await call(dadmin, 'adopt_exposed_table', { exposureId, schema: 'sales', table: 'orders', name: 'Orders', description: 'Order lines for Commerce.' }),
  );
  assert.equal(adopted.dataset.origin, 'connected');
  const got = payload<{ connected: { mode: string; tier: string; status: string; source: { table: string } } | null }>(
    await call(dadmin, 'get_dataset', { datasetId: adopted.dataset.id }),
  );
  assert.ok(got.connected);
  assert.equal(got.connected!.mode, 'live');
  assert.equal(got.connected!.tier, 'gold');
  assert.equal(got.connected!.status, 'ok');
  assert.equal(got.connected!.source.table, 'orders');
});

test('revoke_exposure_set propagates: withdraws + freezes the adopted dataset', async () => {
  const { connId } = await seed();
  const created = payload<{ exposure: { id: string } }>(
    await call(admin, 'create_exposure_set', { connId, name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'gold', tables: [{ schema: 'sales', table: 'orders' }] }),
  );
  const dSees = payload<{ connections: { exposures: { exposureId: string }[] }[] }>(await call(dadmin, 'list_exposed_tables'));
  const exposureId = dSees.connections[0].exposures[0].exposureId;
  const adopted = payload<{ dataset: { id: string } }>(
    await call(dadmin, 'adopt_exposed_table', { exposureId, schema: 'sales', table: 'orders', description: 'Order lines.' }),
  );

  // Revoke (admin) — the adopted dataset is frozen (revokedDatasets ≥ 1).
  const rev = payload<{ revokedDatasets: number }>(await call(admin, 'revoke_exposure_set', { exposureId: created.exposure.id }));
  assert.equal(rev.revokedDatasets, 1);
  // The dataset now reports source-revoked honestly.
  const got = payload<{ connected: { status: string } | null }>(await call(dadmin, 'get_dataset', { datasetId: adopted.dataset.id }));
  assert.equal(got.connected!.status, 'source-revoked');
  // A builder can never revoke.
  assert.equal(errorOf(await call(builder, 'revoke_exposure_set', { exposureId: created.exposure.id })).code, 'forbidden');
});
