/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Server tests for the data-plan RESOLVE action (0.6.101 → 0.6.112). A create-new need
 * CREATES a governed dataset, LANDS its bronze, and then — the 0.6.112 fix — builds
 * Silver+Gold and PROMOTES it to a Domain `asset` so ANY domain user (not just the owner)
 * can read it through the app. We inject the physical Silver/Gold/promote steps (`deps`)
 * plus mock the ingest + dummy-row model, so the test is offline + deterministic while the
 * create + grant + promotion WIRING runs for real (in-memory registry).
 */

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

// The physical bronze landing — capture the grid, return an OK landing.
let LANDED: { datasetId: string; rows: number } | null = null;
mock.module('@/lib/data/ingest', {
  namedExports: {
    landGridAsBronze: async (
      _user: unknown,
      datasetId: string,
      grid: { columns: string[]; rows: string[][] },
    ) => {
      LANDED = { datasetId, rows: grid.rows.length };
      return { ok: true, report: { ok: true }, dataset: { id: datasetId } };
    },
  },
});

// The dummy-row generator — return two rows for the requested columns.
mock.module('@/lib/assistant/complete', {
  namedExports: {
    assistantComplete: async () => ({
      content: JSON.stringify({ rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] }),
      model: 'test',
    }),
  },
});

const { createApp, __resetAppsCache, getAppForUser } = await import('./apps.ts');
const store = await import('../data/store.ts');
const { getDataset, buildVersion, applyApprovedPromotion, __resetStore } = store;
const { resolveDataPlanItem } = await import('./data-plan-server.ts');
type DataPlanDeps = import('./data-plan-server.ts').DataPlanDeps;

const OWNER_BUILDER = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder', allDomains: ['sales'], activeDomain: null } as const;
const OWNER_CREATOR = { id: 'own', name: 'Owner', domains: ['sales'], role: 'creator', allDomains: ['sales'], activeDomain: null } as const;

/**
 * A promote-succeeds dep-set. `buildLayer` flips the medallion flag via the REAL store
 * write (`buildVersion` — a pure registry flip); `promote` flips the tier via the REAL
 * `applyApprovedPromotion`. Both are the pure registry twins of the physical server path,
 * so the create → build → promote → grant WIRING is exercised end-to-end, offline.
 */
function okDeps(): DataPlanDeps & { promoted: string[] } {
  const promoted: string[] = [];
  return {
    promoted,
    async buildLayer(dataset, layer, user) {
      const updated = buildVersion(dataset.id, user, layer, { passThrough: true });
      return { ok: true, dataset: updated };
    },
    async promote(req, approver) {
      promoted.push(req.datasetId);
      const dataset = applyApprovedPromotion(req, approver);
      return { ok: true, fqn: req.target, dataset };
    },
  };
}

/** A promote-FAILS dep-set (materialization backend offline / build ✗). */
function failingPromoteDeps(): DataPlanDeps {
  return {
    async buildLayer(dataset, layer, user) {
      return { ok: true, dataset: buildVersion(dataset.id, user, layer, { passThrough: true }) };
    },
    async promote(req) {
      return { ok: false, fqn: req.target, error: 'the physical publish did not pass' };
    },
  };
}

beforeEach(() => {
  __resetAppsCache();
  __resetStore();
  LANDED = null;
});

async function seedApp(user: typeof OWNER_BUILDER | typeof OWNER_CREATOR = OWNER_BUILDER) {
  return createApp(user, { name: `Plan App ${Math.random().toString(36).slice(2, 7)}`, template: 'sovereign-app' });
}

test('Builder owner: create-empty PROMOTES the new dataset to a Domain asset and grants it', async () => {
  const app = await seedApp();
  const deps = okDeps();
  const res = await resolveDataPlanItem(app.id, OWNER_BUILDER, {
    name: `Employees ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }],
    fill: 'empty',
  }, deps);

  assert.equal(res.rowsPersisted, 0, 'empty ⇒ no rows persisted');
  assert.equal(res.promoted, true, 'the dataset was promoted to Domain');
  assert.ok(!res.warning, 'no owner-only warning on a successful promotion');
  assert.deepEqual(deps.promoted, [res.datasetId], 'the promote path was taken');

  // The dataset is now a Domain asset (readable by domain peers, not owner-only).
  const ds = getDataset(res.datasetId, OWNER_BUILDER);
  assert.equal(ds.tier, 'asset', 'promoted to asset tier');

  // Granted to the app (read-only — reference data is never a write target).
  const after = await getAppForUser(app.id, OWNER_BUILDER);
  const grant = after.grants.data.find((g) => g.id === res.datasetId);
  assert.ok(grant, 'the promoted dataset is granted to the app');
  assert.equal(grant!.access, 'read-only');
});

test('Builder owner: create-dummy persists rows, promotes, and grants', async () => {
  const app = await seedApp();
  const deps = okDeps();
  const res = await resolveDataPlanItem(app.id, OWNER_BUILDER, {
    name: `Cases ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }],
    fill: 'dummy',
    rows: 25,
  }, deps);

  assert.equal(res.rowsPersisted, 2, 'the two generated rows were persisted');
  assert.equal(LANDED?.rows, 2, 'the bronze landed the 2-row grid (not fabricated at read time)');
  assert.equal(res.promoted, true);
  const ds = getDataset(res.datasetId, OWNER_BUILDER);
  assert.equal(ds.tier, 'asset');
  const after = await getAppForUser(app.id, OWNER_BUILDER);
  assert.ok(after.grants.data.some((g) => g.id === res.datasetId), 'granted after promote');
});

test('Creator owner: CANNOT promote → returns a LOUD owner-only warning, dataset stays Personal', async () => {
  const app = await seedApp(OWNER_CREATOR);
  const deps = okDeps(); // deps.promote would succeed, but a Creator must never reach it
  const res = await resolveDataPlanItem(app.id, OWNER_CREATOR, {
    name: `Tickets ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }],
    fill: 'empty',
  }, deps);

  assert.equal(res.promoted, false, 'a Creator did not promote');
  assert.deepEqual(deps.promoted, [], 'the promote dep was never called for a Creator');
  assert.ok(res.warning, 'an explicit owner-only warning is returned');
  assert.match(res.warning!, /only you can read it|private space|Builder must promote/i);
  // Dataset is still Personal (dataset tier) — no silent domain flip.
  const ds = getDataset(res.datasetId, OWNER_CREATOR);
  assert.equal(ds.tier, 'dataset', 'stayed Personal');
});

test('Backend offline / promote ✗: returns the loud warning and does NOT silently succeed', async () => {
  const app = await seedApp();
  const res = await resolveDataPlanItem(app.id, OWNER_BUILDER, {
    name: `Offline ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }],
    fill: 'empty',
  }, failingPromoteDeps());

  assert.equal(res.promoted, false, 'promote failed → not promoted');
  assert.ok(res.warning, 'the failure surfaces a loud warning');
  assert.match(res.warning!, /only you can read it|private space|Builder/i);
  const ds = getDataset(res.datasetId, OWNER_BUILDER);
  assert.equal(ds.tier, 'dataset', 'tier untouched on a failed publish');
});

test('resolveDataPlanItem refuses a column-less item (guard before create)', async () => {
  const app = await seedApp();
  await assert.rejects(
    () => resolveDataPlanItem(app.id, OWNER_BUILDER, { name: 'x', columns: [], fill: 'empty' }),
    /at least one column/,
  );
});
