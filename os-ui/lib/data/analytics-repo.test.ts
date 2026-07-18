/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoClient } from '../infra/forgejo.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { buildCubeModels } from './cube-models.ts';
import { CUBE_ARTIFACT, scaffoldCubeYaml, scaffoldExposureYaml } from './metrics.ts';
import { writeAnalyticsFiles, syncAnalyticsRepo } from './analytics-repo.ts';

/**
 * Unit tests for the analytics monorepo writer against a fake ForgejoClient.
 * No network — the pure module is exercised directly.
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

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
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

type FakeStore = Map<string, string>; // path → content

/** ForgejoClient backed by an in-memory store. Tracks write calls. */
function fakeForgejoFor(store: FakeStore): { client: ForgejoClient; writes: string[] } {
  const writes: string[] = [];
  const client: ForgejoClient = {
    async ensureRepo() {},
    async readFile(_repo, path) {
      const content = store.get(path);
      return content === undefined ? null : { content, sha: `sha:${path}` };
    },
    async writeFile(_repo, path, content, _sha, _message) {
      writes.push(path);
      store.set(path, content);
      return { sha: `sha:${path}:new` };
    },
    async deleteRepo() { return { deleted: true }; },
    async listCommits() { return null; },
    async getCommitFiles() { return null; },
  };
  return { client, writes };
}

// Derive the expected repo path from the artifact path (metrics/<slug>.cube.yml)
function repoPath(d: Dataset): string {
  const artifact = CUBE_ARTIFACT(d);
  return `cube/models/metrics/${artifact.replace(/^metrics\//, '')}`;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('content is byte-identical to buildCubeModels/scaffoldCubeYaml output', async () => {
  const d = ds();
  const store: FakeStore = new Map();
  const { client } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  const payload = buildCubeModels([d]);
  const entry = payload.models[0];
  assert.ok(entry, 'buildCubeModels produced an entry');

  // The written content must be byte-identical to what buildCubeModels emits.
  const writtenCube = store.get(repoPath(d));
  assert.equal(writtenCube, entry.model, 'cube model content byte-identical to buildCubeModels');

  // The scaffoldCubeYaml base (no access policy embed) equals the raw scaffold.
  // (entry.model = cubeModelYaml(d, access, embed) — when no restricted columns
  //  the embed path returns the base unchanged.)
  assert.equal(writtenCube, scaffoldCubeYaml(d), 'also byte-identical to scaffoldCubeYaml (no restricted cols)');
});

test('diff-only: no write when content is unchanged', async () => {
  const d = ds();
  const payload = buildCubeModels([d]);
  const entry = payload.models[0];

  // Pre-populate the store with the exact current content.
  const store: FakeStore = new Map([
    [repoPath(d), entry.model],
  ]);
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  // The cube file write should have been skipped (content unchanged).
  assert.ok(!writes.includes(repoPath(d)), 'no write when cube content is unchanged');
});

test('diff-only: writes when content changes', async () => {
  const d = ds();
  const store: FakeStore = new Map([
    [repoPath(d), '# stale content'],
  ]);
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  assert.ok(writes.includes(repoPath(d)), 'writes when content differs from stored value');
});

test('legacy (non-namespaced) dataset uses the legacy path — no cubeNamespaced flag', async () => {
  // A dataset without cubeNamespaced=true (legacy, pre-#155) must produce the
  // bare slug path: cube/models/metrics/orders.cube.yml (not sales__orders.cube.yml).
  const d = ds({ cubeNamespaced: undefined });
  assert.ok(!d.cubeNamespaced, 'test dataset is legacy (not namespaced)');

  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  // Legacy path: slug('Orders') = 'orders' → cube/models/metrics/orders.cube.yml
  assert.ok(writes.some((p) => p === 'cube/models/metrics/orders.cube.yml'),
    'legacy dataset writes to bare-slug path');
  assert.ok(!writes.some((p) => p.includes('sales__')),
    'legacy dataset must NOT produce a namespaced path');
});

test('namespaced (#155) dataset uses the namespaced path', async () => {
  const d = ds({ cubeNamespaced: true });

  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  // Namespaced path: sales__orders → cube/models/metrics/sales__orders.cube.yml
  assert.ok(writes.some((p) => p === 'cube/models/metrics/sales__orders.cube.yml'),
    'namespaced dataset writes to domain__slug path');
});

test('exposure file is written and contains scaffoldExposureYaml output', async () => {
  const d = ds();
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  assert.ok(writes.includes('dbt/models/exposures.yml'), 'exposures file written');
  const content = store.get('dbt/models/exposures.yml') ?? '';
  // The expected exposure YAML comes directly from scaffoldExposureYaml.
  const expected = scaffoldExposureYaml(d);
  // Our file wraps all exposures under a single `exposures:` header.
  assert.match(content, /^exposures:\n/, 'exposure file has correct header');
  // The per-dataset block (minus its own `exposures:` header) must be present.
  const block = expected.replace(/^exposures:\n/, '');
  assert.ok(content.includes(block), 'exposure body byte-identical to scaffoldExposureYaml output');
});

test('no exposure file when there are no governed datasets', async () => {
  // A dataset that is not yet promoted (tier='dataset') should not appear.
  const d = ds({ tier: 'dataset' });
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  assert.ok(!writes.includes('dbt/models/exposures.yml'), 'no exposure file for un-promoted datasets');
  assert.equal(writes.length, 0, 'no writes at all for un-deliverable dataset');
});

test('syncAnalyticsRepo is fire-and-forget: swallows write errors without throwing', async () => {
  // A client that throws on every write.
  const broken: ForgejoClient = {
    async ensureRepo() {},
    async readFile() { return null; }, // no existing content → will try to write
    async writeFile() { throw new Error('forgejo unreachable'); },
    async deleteRepo() { return { deleted: true }; },
    async listCommits() { return null; },
    async getCommitFiles() { return null; },
  };
  const d = ds();
  // Must NOT throw (fire-and-forget contract).
  assert.doesNotThrow(() => syncAnalyticsRepo(broken, [d], 'approver'));
  // Give the microtask queue a tick to ensure the internal promise settles.
  await new Promise((r) => setImmediate(r));
  // Still no throw from the settled promise (verified by test not rejecting).
});
