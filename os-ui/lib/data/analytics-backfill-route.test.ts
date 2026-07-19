/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The admin analytics BACKFILL route (POST) driven through the REAL handler, with
 * `requireAdmin`, `realForgejo` and `listGovernedDatasets` mocked. The REAL
 * `writeAnalyticsFiles` runs against a fake in-memory ForgejoClient so we prove:
 *   - every governed dataset's cube model lands in git,
 *   - the summary (cubeModelsWritten / dbtModelsWritten) is returned,
 *   - admin gating rejects a non-admin (403),
 *   - an unreachable Forgejo yields 503 (never a fabricated success).
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoClient } from '../infra/forgejo.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { CUBE_ARTIFACT } from './metrics.ts';

// ─── mockable state ──────────────────────────────────────────────────────────
let ADMIN_OK = true;
let DATASETS: Dataset[] = [];
let FORGEJO: ForgejoClient;

mock.module('@/lib/core/auth', {
  namedExports: {
    requireAdmin: async () => {
      if (!ADMIN_OK) {
        const err = new Error('Admin only') as Error & { status?: number };
        err.status = 403;
        throw err;
      }
      return { id: 'root', name: 'Root', domains: [], role: 'admin' };
    },
  },
});
mock.module('@/lib/agents/build/live-clients', {
  namedExports: { realForgejo: () => FORGEJO },
});
mock.module('@/lib/data/store', {
  namedExports: { listGovernedDatasets: () => DATASETS },
});

// ─── fixtures ────────────────────────────────────────────────────────────────
function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

type FakeStore = Map<string, string>;
function fakeForgejo(store: FakeStore, opts: { writeThrows?: boolean; ensureThrows?: boolean } = {}): ForgejoClient {
  return {
    async ensureRepo() { if (opts.ensureThrows) throw new Error('ECONNREFUSED'); },
    async readFile(_repo, path) {
      const content = store.get(path);
      return content === undefined ? null : { content, sha: `sha:${path}` };
    },
    async writeFile(_repo, path, content) {
      if (opts.writeThrows) throw new Error('forgejo write failed');
      store.set(path, content);
      return { sha: `sha:${path}:new` };
    },
    async deleteRepo() { return { deleted: true }; },
    async listCommits() { return null; },
    async getCommitFiles() { return null; },
  };
}

function repoPath(d: Dataset): string {
  return `cube/models/metrics/${CUBE_ARTIFACT(d).replace(/^metrics\//, '')}`;
}

async function post() {
  const route = await import(`../../app/api/admin/analytics/backfill/route.ts?${Math.random()}`);
  return route.POST();
}

beforeEach(() => { ADMIN_OK = true; DATASETS = []; });

// ─── tests ───────────────────────────────────────────────────────────────────
test('writes every governed dataset cube model and returns the summary', async () => {
  const d1 = ds({ id: 'ds_orders', name: 'Orders' });
  const d2 = ds({ id: 'ds_customers', name: 'Customers',
    columns: [{ name: 'customer_id', description: 'PK.' }] });
  DATASETS = [d1, d2];
  const store: FakeStore = new Map();
  FORGEJO = fakeForgejo(store);

  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.datasets, 2);
  // Both datasets' cube models are present in the summary AND in the fake git store.
  for (const d of [d1, d2]) {
    assert.ok(body.cubeModelsWritten.includes(repoPath(d)), `${d.name} cube in summary`);
    assert.ok(store.has(repoPath(d)), `${d.name} cube landed in git`);
  }
  // The dbt exposures file is reported under dbtModelsWritten.
  assert.ok(body.dbtModelsWritten.includes('dbt/models/exposures.yml'), 'exposures reported as dbt');
  assert.deepEqual(body.errors, []);
});

test('non-admin is rejected 403 and nothing is written', async () => {
  ADMIN_OK = false;
  DATASETS = [ds()];
  const store: FakeStore = new Map();
  FORGEJO = fakeForgejo(store);

  const res = await post();
  assert.equal(res.status, 403);
  assert.equal(store.size, 0, 'no writes for a rejected caller');
});

test('unreachable Forgejo yields 503, never a fabricated success', async () => {
  DATASETS = [ds()];
  const store: FakeStore = new Map();
  FORGEJO = fakeForgejo(store, { ensureThrows: true });

  const res = await post();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unreachable/i);
});

test('a mid-backfill write failure surfaces as 503 with the error (no fabricated ok)', async () => {
  DATASETS = [ds()];
  const store: FakeStore = new Map();
  FORGEJO = fakeForgejo(store, { writeThrows: true });

  const res = await post();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.length > 0, 'error surfaced honestly');
});

test('empty governed set → ok with empty summaries', async () => {
  DATASETS = [];
  const store: FakeStore = new Map();
  FORGEJO = fakeForgejo(store);

  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.datasets, 0);
  assert.deepEqual(body.cubeModelsWritten, []);
  assert.deepEqual(body.dbtModelsWritten, []);
});
