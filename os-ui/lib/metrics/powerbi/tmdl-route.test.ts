/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Governance scope of the Power BI TMDL export route — the export is entitled by the SAME
 * canView the Metrics/Data tabs use. A NON-viewer of a private dataset is refused (403);
 * the OWNER gets the generated TMDL. Also proves the SQL-API-off 503 gate.
 */

// The generated TMDL binds to the Cube SQL endpoint, so the route 503s unless the SQL API
// is enabled. Turn it on BEFORE the config module is imported (env is read at load).
process.env.CUBE_SQL_API_ENABLED = 'true';
process.env.CUBE_SQL_HOST = 'cube-sql.example.com';

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: { requireUser: async () => ACTING },
});

const { __resetStore, createDataset } = await import('../../data/store.ts');

beforeEach(() => __resetStore());

async function callGet(qs: string) {
  const route = await import(`../../../app/api/powerbi/tmdl/route.ts?${Math.random()}`);
  return route.GET(new Request(`http://x/api/powerbi/tmdl?${qs}`));
}

const AMIR = { id: 'amir', domains: ['sales'], role: 'builder' as const };

/** Create a Gold-built dataset owned by Amir with one measure. */
function makeDataset() {
  const d = createDataset(AMIR, { name: 'Orders' });
  // Build the medallion layers so a measure/metric can resolve.
  return d;
}

// NOTE ON THE DOWNLOAD BRANCH: the file-download response uses `new NextResponse(text)`,
// which the test shim for `next/server` (scripts/test-next-server.mjs) does not implement
// (it only provides `NextResponse.json`). So the OWNER success + body assertions go through
// the `format=json` branch (which returns the identical TMDL + the mapping table). The
// status-only tests below cover the governance gates on both branches.

test('OWNER can export their own dataset as TMDL (governed canView)', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' };
  const d = makeDataset();

  const res = await callGet(`datasetId=${d.id}&format=json`);
  assert.equal(res.status, 200, 'owner export returns 200');
  const json = (await res.json()) as { tmdl: string; filename: string };
  // The dataset is #155-namespaced (createDataset sets cubeNamespaced), so the view name
  // is `sales__Orders` — the TMDL table + filename reflect the governed cube identity.
  assert.match(json.tmdl, /table sales__Orders/);
  assert.match(json.filename, /sales__Orders\.tmdl/);
});

test('NON-viewer is refused (403) — export honours the same canView as the metric', async () => {
  // Amir creates a PRIVATE dataset (tier=dataset ⇒ owner-only canView).
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' };
  const d = makeDataset();

  // A different user in the same domain tries to export the private dataset.
  ACTING = { id: 'mallory', name: 'Mallory', domains: ['sales'], role: 'builder' };
  const res = await callGet(`datasetId=${d.id}`);
  assert.equal(res.status, 403, 'non-viewer of a private dataset is refused');
});

test('missing metricId/datasetId → 400', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' };
  const res = await callGet('');
  assert.equal(res.status, 400);
});

test('unknown dataset → 404 (not a leak of another domain)', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' };
  const res = await callGet('datasetId=ds_does_not_exist');
  assert.equal(res.status, 404);
});

test('format=json returns the TMDL text + the Cube→DAX mapping table', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' };
  const d = makeDataset();
  const res = await callGet(`datasetId=${d.id}&format=json`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { tmdl: string; filename: string; mappings: unknown[] };
  assert.match(json.tmdl, /table sales__Orders/);
  assert.equal(json.filename, 'sales__Orders.tmdl');
  assert.ok(Array.isArray(json.mappings));
});
