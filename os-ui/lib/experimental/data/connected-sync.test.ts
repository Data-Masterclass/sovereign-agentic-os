/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * SYNC-mode connected datasets (lakehouse-import-exposure.md, Phase 3): the sync-target
 * resolution to the domain schema, the FQN seam for connected-sync, the revocation FREEZE
 * (sync disabled + copy KEPT), and metric-source inclusion for synced copies (vs exclusion
 * for live). Store-level + pure, offline: the mirror is a graceful no-op.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  adoptConnectedDataset,
  buildVersion,
  builtLayerFqn,
  getDataset,
  markDatasetsSourceRevoked,
  type Principal,
} from './store.ts';
import { syncTargetFor } from './sync-run-server.ts';
import { metricSqlReady } from './metrics.ts';
import { parseSyncBlock, type ConnectedSource, type DatasetSync } from './dataset-schema.ts';

const dadmin: Principal = { id: 'dana', domains: ['commerce'], role: 'domain_admin' };
const viewer: Principal = { id: 'vic', domains: ['commerce'], role: 'creator' };

beforeEach(() => __resetStore());

function syncBlock(over: Partial<DatasetSync> = {}): DatasetSync {
  return {
    connectionId: 'conn_1',
    source: { schema: 'public', table: 'orders' },
    mode: 'append',
    cursor: { kind: 'timestamp', column: 'updated_at' },
    schedule: { cron: '0 6 * * *' },
    enabled: true,
    ...over,
  };
}

function connected(over: Partial<ConnectedSource> = {}): ConnectedSource {
  return {
    connectionId: 'conn_1',
    exposureId: 'exp_sync',
    source: { catalog: 'glue_sales', schema: 'public', table: 'orders' },
    mode: 'sync',
    tier: 'gold',
    status: 'ok',
    ...over,
  };
}

function adoptSync(over: { connected?: Partial<ConnectedSource>; sync?: Partial<DatasetSync> } = {}) {
  return adoptConnectedDataset(dadmin, {
    name: 'Orders (synced)',
    domain: 'commerce',
    description: 'A synced copy of orders from the Databricks connection.',
    connected: connected(over.connected),
    sync: syncBlock(over.sync),
  });
}

// ---------------------------------------------------------- adopt (sync) -------

test('adoptConnectedDataset (sync): born at DOMAIN tier, tier UNBUILT until first landing, sync attached', () => {
  const d = adoptSync();
  assert.equal(d.tier, 'asset');
  assert.equal(d.origin, 'connected');
  assert.equal(d.connected?.mode, 'sync');
  // Earned status: no version is built at adopt — the tier lights only after a real landing.
  assert.equal(d.versions.gold.built, false);
  assert.equal(d.versions.silver.built, false);
  assert.equal(d.versions.bronze.built, false);
  assert.equal(d.sync?.connectionId, 'conn_1');
  assert.equal(d.sync?.enabled, true);
});

// ---------------------------------------------------- sync-target resolution ---

test('syncTargetFor: a connected-sync dataset targets iceberg.<domainSchema>.<tier>_<slug>', () => {
  const d = adoptSync();
  const target = syncTargetFor(d, { id: 'dana' });
  assert.equal(target.schema, 'commerce');
  assert.equal(target.table, 'gold_orders_synced'); // tier_<physicalSlug(name)>
});

test('syncTargetFor: a silver-tier sync targets the silver copy', () => {
  const d = adoptSync({ connected: { tier: 'silver' } });
  const target = syncTargetFor(d, { id: 'dana' });
  assert.equal(target.table, 'silver_orders_synced');
});

test('syncTargetFor: a NON-connected dataset still lands in the owner personal bronze lane', () => {
  // A plain (ingest) dataset shape — no connected block.
  const plain = { domain: 'commerce', name: 'Uploads', slug: 'uploads', versions: {} } as never;
  const target = syncTargetFor(plain, { id: 'dana' });
  assert.equal(target.schema, 'personal_dana');
  assert.equal(target.table, 'bronze_uploads');
});

// -------------------------------------------------------------- FQN seam -------

test('builtLayerFqn (sync): null until the tier is built, then the domain-schema copy + domain principal', () => {
  const d = adoptSync();
  // Before the first landing: not materialized yet.
  assert.equal(builtLayerFqn(getDataset(d.id, viewer), viewer), null);
  // Simulate the first successful landing lighting the tier (what the executor does).
  buildVersion(d.id, dadmin, 'gold', {});
  const resolved = builtLayerFqn(getDataset(d.id, viewer), viewer);
  assert.ok(resolved);
  assert.equal(resolved!.layer, 'gold');
  assert.equal(resolved!.fqn, 'iceberg.commerce.gold_orders_synced', 'reads the LOCAL governed copy');
  assert.equal(resolved!.principal, 'commerce', 'reads AS the viewer domain principal');
});

// ----------------------------------------------------- revocation freeze -------

test('markDatasetsSourceRevoked (sync): FREEZES — sync disabled, copy KEPT, status revoked', () => {
  const d = adoptSync();
  buildVersion(d.id, dadmin, 'gold', {}); // a landing happened — the copy exists
  const affected = markDatasetsSourceRevoked('exp_sync');
  assert.equal(affected.length, 1);
  const after = getDataset(d.id, dadmin);
  assert.equal(after.connected?.status, 'source-revoked');
  // The sync is disabled (no further landing runs)…
  assert.equal(after.sync?.enabled, false);
  // …but the last-landed copy is KEPT — the tier version stays built and still resolves.
  assert.equal(after.versions.gold.built, true);
  const resolved = builtLayerFqn(after, viewer);
  assert.ok(resolved, 'a frozen sync copy is still queryable (sovereign data)');
  assert.equal(resolved!.fqn, 'iceberg.commerce.gold_orders_synced');
});

// -------------------------------------------------- metric-source inclusion ----

test('metricSqlReady: a SYNCED copy with a built gold is metric-ready (define metrics on the copy)', () => {
  const d = adoptSync();
  buildVersion(d.id, dadmin, 'gold', {});
  const ready = metricSqlReady(getDataset(d.id, dadmin));
  assert.equal(ready.ok, true, 'synced connected datasets are NOT excluded from metrics');
});

test('metricSqlReady: a LIVE connected dataset is excluded (steer to a synced copy)', () => {
  const live = adoptConnectedDataset(dadmin, {
    name: 'Orders (live)',
    domain: 'commerce',
    description: 'Live orders.',
    connected: connected({ exposureId: 'exp_live', mode: 'live', tier: 'gold' }),
  });
  const ready = metricSqlReady(getDataset(live.id, dadmin));
  assert.equal(ready.ok, false);
  assert.match(ready.message ?? '', /synced copy/i);
});

// ------------------------------------------- adopt-dialog config validation ----
// The dialog assembles a DatasetSync the adopt route re-validates with parseSyncBlock
// (connection + source PINNED to the exposure). These mirror the route's accept/reject.

test('adopt sync config: full-refresh needs no cursor (a valid minimal config)', () => {
  const ok = parseSyncBlock({
    connectionId: 'conn_1', source: { schema: 'public', table: 'orders' },
    mode: 'full-refresh', schedule: { cron: '0 6 * * *' }, enabled: true,
  });
  assert.ok(ok);
  assert.equal(ok!.mode, 'full-refresh');
  assert.equal(ok!.cursor, undefined);
});

test('adopt sync config: an incremental config carries its cursor; a bad cron is rejected', () => {
  const withCursor = parseSyncBlock({
    connectionId: 'conn_1', source: { schema: 'public', table: 'orders' },
    mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' },
    schedule: { cron: '0 * * * *' }, enabled: true,
  });
  assert.ok(withCursor);
  assert.equal(withCursor!.cursor?.column, 'updated_at');
  // A malformed schedule fails the parse (the route then returns a 400).
  const badCron = parseSyncBlock({
    connectionId: 'conn_1', source: { schema: 'public', table: 'orders' },
    mode: 'full-refresh', schedule: { cron: 'not-a-cron' }, enabled: true,
  });
  assert.equal(badCron, undefined);
});
