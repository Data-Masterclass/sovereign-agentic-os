/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Server tests for the data-plan RESOLVE action (0.6.101): create-empty and create-dummy
 * each CREATE a governed dataset, LAND its bronze through the shared ingest path, and GRANT
 * it to the app. We mock the physical ingest (`landGridAsBronze`) + the dummy-row model
 * (`assistantComplete`) so the test is offline + deterministic; `createApp`/`createDataset`/
 * `patchAppDesign` run for real (in-memory cache), proving the create + grant wiring.
 */

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

// The physical bronze landing — capture the grid it was handed (empty vs dummy rows).
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

const { createApp, patchAppDesign, __resetAppsCache, getAppForUser } = await import('./apps.ts');
const { getDataset } = await import('../data/store.ts');
const { resolveDataPlanItem } = await import('./data-plan-server.ts');

const OWNER = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder', allDomains: ['sales'], activeDomain: null } as const;

beforeEach(() => {
  __resetAppsCache();
  LANDED = null;
});

async function seedApp() {
  return createApp(OWNER, { name: `Plan App ${Math.random().toString(36).slice(2, 7)}`, template: 'sovereign-app' });
}

test('create-empty: creates a schema-only dataset (0 rows) and grants it to the app', async () => {
  const app = await seedApp();
  const res = await resolveDataPlanItem(app.id, OWNER, {
    name: `Employees ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }],
    fill: 'empty',
  });

  assert.equal(res.rowsPersisted, 0, 'empty ⇒ no rows persisted');
  assert.equal(LANDED?.rows, 0, 'the bronze landed a header-only grid');
  // Dataset created with the seeded schema + sample label.
  const ds = getDataset(res.datasetId, OWNER);
  assert.deepEqual(ds.columns.map((c) => c.name), ['id', 'name']);
  assert.match(ds.description, /sample data/i);
  // Granted to the app (read-only).
  const after = await getAppForUser(app.id, OWNER);
  const grant = after.grants.data.find((g) => g.id === res.datasetId);
  assert.ok(grant, 'the new dataset is granted to the app');
  assert.equal(grant!.access, 'read-only');
});

test('create-dummy: persists AI sample rows through the ingest path and grants it', async () => {
  const app = await seedApp();
  const res = await resolveDataPlanItem(app.id, OWNER, {
    name: `Cases ${Math.random().toString(36).slice(2, 6)}`,
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }],
    fill: 'dummy',
    rows: 25,
  });

  assert.equal(res.rowsPersisted, 2, 'the two generated rows were persisted');
  assert.equal(LANDED?.rows, 2, 'the bronze landed the 2-row grid (not fabricated at read time)');
  assert.equal(LANDED?.datasetId, res.datasetId);
  const after = await getAppForUser(app.id, OWNER);
  assert.ok(after.grants.data.some((g) => g.id === res.datasetId), 'granted after materialize');
});

test('resolveDataPlanItem refuses a column-less item (guard before create)', async () => {
  const app = await seedApp();
  await assert.rejects(
    () => resolveDataPlanItem(app.id, OWNER, { name: 'x', columns: [], fill: 'empty' }),
    /at least one column/,
  );
});
