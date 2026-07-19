/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * #147 — INGESTION ORCHESTRATOR tests. The orchestrator FOLDS the already-tested
 * metadata + DQ write-back engines over the governed marts, so these tests focus on
 * the orchestrator's OWN behaviour: the roll-up shapes under the guards, the OM-down
 * graceful no-op, a non-OS / non-promoted mart being an honest skip (never a fabricated
 * write), and the version fail-closed refusal surfacing as a no-op (not a crash).
 *
 * We mock the three seams the orchestrator imports (the OM bridge, the dataset store,
 * the config flag) so no server-only OM/secret/network path is exercised. The engines
 * themselves are covered by openmetadata-sync.test.ts / openmetadata-dq.test.ts.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset } from '@/lib/data';
import type { CurrentUser } from '@/lib/core/auth';

// The dedicated OS namespace prefix (mirrors OS_SERVICE in openmetadata-sync.ts). Kept
// as a literal so this test never eagerly imports a server-only module before the
// mock.module() calls below register (import hoisting would otherwise load the real
// store/config transitively and defeat the mocks).
const OS_SERVICE = 'sovereign_os';

// --- Tunable fixtures the mocked seams read -----------------------------------
let dqEnabled = false;
let connection: { id: string; name: string } | null = { id: 'conn_om', name: 'Customer OM' };
let governedMarts: Dataset[] = [];
// Per-dataset canned engine outcomes, keyed by dataset id.
const previewMeta = new Map<string, { ok: boolean; summary: string; rejected?: string; counts: { creates: number; patches: number; edges: number; humanFieldsTouched: 0 } }>();
const previewDq = new Map<string, { ok: boolean; summary: string; rejected?: string; counts: { suites: number; testCases: number; humanFieldsTouched: 0 } }>();
const applyMeta = new Map<string, unknown>();
const applyDq = new Map<string, unknown>();
// Records what the orchestrator actually attempted to write (proves no fabricated writes).
const applyCalls: { fqnPrefixOk: boolean; datasetId: string }[] = [];

// `config` is a STABLE object with a LIVE getter property, so the orchestrator reads
// the current `dqEnabled` on each access (a plain value would freeze at import time).
const configStub = {} as { openmetadataDqWritebackEnabled: boolean };
Object.defineProperty(configStub, 'openmetadataDqWritebackEnabled', { get: () => dqEnabled, enumerable: true });
mock.module('@/lib/core/config', { namedExports: { config: configStub } });

mock.module('@/lib/data/store', {
  namedExports: {
    listDatasets: () => ({
      mine: [],
      domain: governedMarts.filter((d) => d.tier === 'asset').map((d) => ({ id: d.id })),
      marketplace: governedMarts.filter((d) => d.tier === 'product').map((d) => ({ id: d.id })),
    }),
    getDataset: (id: string) => {
      const d = governedMarts.find((x) => x.id === id);
      if (!d) throw new Error('not found');
      return d;
    },
  },
});

mock.module('@/lib/connections/openmetadata', {
  namedExports: {
    firstOmCatalogFor: async () => connection,
    previewOmSyncForConnection: (_c: unknown, d: Dataset) =>
      previewMeta.get(d.id) ?? { ok: true, summary: `meta ${d.name}`, counts: { creates: 1, patches: 0, edges: 0, humanFieldsTouched: 0 } },
    previewDqSyncForConnection: (_c: unknown, d: Dataset) =>
      previewDq.get(d.id) ?? { ok: true, summary: `dq ${d.name}`, counts: { suites: 1, testCases: 2, humanFieldsTouched: 0 } },
    applyOmSyncForConnection: async (_c: unknown, d: Dataset) => {
      // The OS gold table FQN the engine would target — assert it is OS-namespaced.
      applyCalls.push({ datasetId: d.id, fqnPrefixOk: `${OS_SERVICE}.${d.domain}.gold_${d.name.toLowerCase()}`.startsWith(`${OS_SERVICE}.`) });
      const out = applyMeta.get(d.id);
      if (out === 'THROW') throw new Error('boom');
      return out ?? { ok: true, applied: { creates: 1, patches: 0, edges: 0 }, conflicts: [], errors: [] };
    },
    applyDqSyncForConnection: async (_c: unknown, d: Dataset) =>
      applyDq.get(d.id) ?? { ok: true, applied: { suites: 1, testCases: 2 }, errors: [] },
  },
});

const { previewCatalogIngest, applyCatalogIngest } = await import('@/lib/connections/openmetadata-ingest.ts');

const USER: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'admin' };

function mart(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'product', visibility: 'shared', description: 'x', versions, grants: [],
    measures: [], columns: [{ name: 'id', description: 'k' }], ...over,
  };
}

function reset() {
  dqEnabled = false;
  connection = { id: 'conn_om', name: 'Customer OM' };
  governedMarts = [];
  previewMeta.clear(); previewDq.clear(); applyMeta.clear(); applyDq.clear();
  applyCalls.length = 0;
}

// ============================ PREVIEW (read-only) ==============================

test('preview rolls up metadata + DQ counts across governed marts (DQ enabled)', async () => {
  reset();
  dqEnabled = true;
  governedMarts = [mart({ id: 'a', name: 'Orders' }), mart({ id: 'b', name: 'Refunds', tier: 'asset' })];
  const p = await previewCatalogIngest(USER);
  assert.equal(p.ok, true);
  assert.equal(p.connectionName, 'Customer OM');
  assert.equal(p.totals.datasets, 2);
  assert.equal(p.totals.syncable, 2);
  assert.equal(p.totals.creates, 2);      // 1 per mart
  assert.equal(p.totals.suites, 2);       // 1 per mart
  assert.equal(p.totals.testCases, 4);    // 2 per mart
  assert.match(p.summary, /2\/2 governed mart/);
  assert.match(p.summary, /ZERO human fields/);
});

test('preview omits the DQ leg when DQ write-back is disabled', async () => {
  reset();
  dqEnabled = false;
  governedMarts = [mart({ id: 'a' })];
  const p = await previewCatalogIngest(USER);
  assert.equal(p.datasets[0].dq, undefined);
  assert.equal(p.totals.suites, 0);
  assert.equal(p.totals.testCases, 0);
  assert.doesNotMatch(p.summary, /TestSuite/);
});

test('preview: a non-promoted / no-Gold mart is a non-syncable line, not a write', async () => {
  reset();
  governedMarts = [
    mart({ id: 'ok', name: 'Good' }),
    mart({ id: 'bad', name: 'Draft' }),
  ];
  previewMeta.set('bad', { ok: false, summary: 'rejected', rejected: 'The Gold layer is not built — nothing to publish into OpenMetadata.', counts: { creates: 0, patches: 0, edges: 0, humanFieldsTouched: 0 } });
  const p = await previewCatalogIngest(USER);
  assert.equal(p.totals.datasets, 2);
  assert.equal(p.totals.syncable, 1); // only the good one
  assert.equal(p.totals.creates, 1);
});

test('preview: OM-absent → calm ok no-op (nothing to refresh)', async () => {
  reset();
  connection = null;
  governedMarts = [mart({ id: 'a' })];
  const p = await previewCatalogIngest(USER);
  assert.equal(p.ok, true);
  assert.equal(p.connectionName, null);
  assert.equal(p.datasets.length, 0);
  assert.equal(p.totals.syncable, 0);
  assert.match(p.summary, /nothing to refresh/i);
});

// ============================ APPLY (executes) =================================

test('apply folds the engines over every mart and rolls up applied counts (OS namespace only)', async () => {
  reset();
  dqEnabled = true;
  governedMarts = [mart({ id: 'a', name: 'Orders' }), mart({ id: 'b', name: 'Refunds', tier: 'asset' })];
  const r = await applyCatalogIngest(USER);
  assert.equal(r.ok, true);
  assert.equal(r.totals.datasets, 2);
  assert.equal(r.totals.creates, 2);
  assert.equal(r.totals.suites, 2);
  assert.equal(r.totals.testCases, 4);
  // Guard 1 witness: every attempted write targeted an OS-namespaced FQN.
  assert.equal(applyCalls.length, 2);
  assert.ok(applyCalls.every((c) => c.fqnPrefixOk));
});

test('apply: a refused (version fail-closed) leg is an honest no-op, not a failure', async () => {
  reset();
  governedMarts = [mart({ id: 'a' })];
  applyMeta.set('a', { ok: false, applied: { creates: 0, patches: 0, edges: 0 }, conflicts: [], errors: [], refused: 'OM version 2.0.0 is outside the tested write range — refusing to write.' });
  const r = await applyCatalogIngest(USER);
  assert.equal(r.ok, true);            // refused ≠ error → the refresh still "ok"
  assert.equal(r.totals.creates, 0);   // nothing fabricated
  assert.match(r.datasets[0].metadata.refused ?? '', /outside the tested write range/);
});

test('apply: a real write error flips ok=false (honest failure surfaced)', async () => {
  reset();
  governedMarts = [mart({ id: 'a' })];
  applyMeta.set('a', { ok: false, applied: { creates: 0, patches: 0, edges: 0 }, conflicts: [], errors: ['PUT sovereign_os.sales.gold_orders: OpenMetadata 500'] });
  const r = await applyCatalogIngest(USER);
  assert.equal(r.ok, false);
});

test('apply: OM-absent → ok no-op, writes nothing', async () => {
  reset();
  connection = null;
  governedMarts = [mart({ id: 'a' })];
  const r = await applyCatalogIngest(USER);
  assert.equal(r.ok, true);
  assert.equal(r.connectionName, null);
  assert.equal(r.datasets.length, 0);
  assert.equal(applyCalls.length, 0);  // never attempted a write
});

test('apply: an unexpected throw in one leg is caught → non-blocking no-op, fold continues', async () => {
  reset();
  governedMarts = [mart({ id: 'a', name: 'Boom' }), mart({ id: 'b', name: 'Fine', tier: 'asset' })];
  applyMeta.set('a', 'THROW'); // the mocked engine throws for dataset a
  const r = await applyCatalogIngest(USER);
  // The throw is swallowed to an honest refused no-op; the second mart still syncs.
  assert.equal(r.totals.datasets, 2);
  assert.match(r.datasets.find((x) => x.datasetId === 'a')!.metadata.refused ?? '', /non-blocking/);
  assert.equal(r.datasets.find((x) => x.datasetId === 'b')!.metadata.applied.creates, 1);
});
