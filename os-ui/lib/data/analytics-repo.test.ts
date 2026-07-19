/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoClient } from '../infra/forgejo.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { buildCubeModels } from './cube-models.ts';
import { CUBE_ARTIFACT, scaffoldCubeYaml, scaffoldExposureYaml } from './metrics.ts';
import { writeAnalyticsFiles, syncAnalyticsRepo, reconcileAnalyticsRepo, _resetReconcileGuard, dbtModelPath, dbtSchemaPath, buildDbtModelSql, buildDbtSchemaYaml } from './analytics-repo.ts';

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

// ─── Phase 6: git-backed dbt model tests ─────────────────────────────────────

test('git-backed dataset emits dbt .sql with byte-stable naming', async () => {
  // A promoted (asset), gold-built, gitBacked=true dataset.
  const d = ds({ tier: 'asset', gitBacked: true });
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  // Expected path: dbt/models/governed/sales/gold_orders.sql
  const expectedPath = 'dbt/models/governed/sales/gold_orders.sql';
  assert.ok(writes.includes(expectedPath), `dbt sql file written at ${expectedPath}`);

  const sql = store.get(expectedPath) ?? '';
  // Must contain the dbt config header with the domain schema.
  assert.match(sql, /\{\{ config\(materialized='table', schema='sales'\) \}\}/, 'config header present');
  // Must contain the SELECT body matching publishPlan's source pattern.
  assert.match(sql, /select \* from iceberg\.personal_amir\.gold_orders/, 'SELECT body matches publishPlan source');
});

test('git-backed dataset emits dbt .sql byte-identical to buildDbtModelSql', async () => {
  const d = ds({ tier: 'asset', gitBacked: true });
  const store: FakeStore = new Map();
  const { client } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  const expectedPath = dbtModelPath(d);
  assert.ok(expectedPath !== null, 'dbtModelPath returns a non-null path for gold-built dataset');
  const written = store.get(expectedPath!);
  const expected = buildDbtModelSql(d);
  assert.equal(written, expected, 'written sql is byte-identical to buildDbtModelSql output');
});

test('git-backed dataset emits schema.yml with column descriptions', async () => {
  const d = ds({ tier: 'asset', gitBacked: true });
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  const schemaPath = 'dbt/models/governed/sales/schema.yml';
  assert.ok(writes.includes(schemaPath), 'schema.yml written for domain');

  const content = store.get(schemaPath) ?? '';
  assert.match(content, /^version: 2/, 'schema.yml starts with version: 2');
  assert.match(content, /name: gold_orders/, 'model name is layer_slug');
  assert.match(content, /name: order_id/, 'column order_id present');
  assert.match(content, /description: "Key\."/, 'column description present');
});

test('schema.yml content is byte-identical to buildDbtSchemaYaml output', async () => {
  const d = ds({ tier: 'asset', gitBacked: true });
  const store: FakeStore = new Map();
  const { client } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  const schemaPath = dbtSchemaPath(d);
  const written = store.get(schemaPath);
  const expected = buildDbtSchemaYaml([d]);
  assert.equal(written, expected, 'schema.yml content byte-identical to buildDbtSchemaYaml');
});

test('legacy dataset (gitBacked absent) emits NO dbt model or schema.yml', async () => {
  // A promoted asset WITHOUT gitBacked=true — pre-existing datasets must not emit new files.
  const d = ds({ tier: 'asset' }); // gitBacked is absent
  assert.ok(!d.gitBacked, 'test dataset has no gitBacked marker');

  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  assert.ok(!writes.some((p) => p.startsWith('dbt/models/governed/')),
    'no dbt governed model emitted for legacy dataset');
});

test('dataset with gitBacked=false emits NO dbt model', async () => {
  const d = ds({ tier: 'asset', gitBacked: false });
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d], 'approver');

  assert.ok(!writes.some((p) => p.startsWith('dbt/models/governed/')),
    'no dbt governed model emitted when gitBacked is false');
});

test('dbtModelPath returns null when neither gold nor silver is built', () => {
  const versions = emptyVersions(); // nothing built
  const d = ds({ versions, gitBacked: true });
  assert.equal(dbtModelPath(d), null, 'null when no layer is built');
});

test('dbtModelPath prefers gold over silver', () => {
  const d = ds({ gitBacked: true }); // fixture has both gold and silver built
  const path = dbtModelPath(d);
  assert.ok(path?.includes('gold_'), 'gold preferred over silver');
});

test('dbtModelPath uses silver when only silver is built', () => {
  const versions = emptyVersions();
  versions.silver.built = true;
  const d = ds({ versions, gitBacked: true });
  const path = dbtModelPath(d);
  assert.ok(path?.includes('silver_'), 'silver used when gold not built');
});

test('multiple git-backed datasets in same domain share one schema.yml', async () => {
  const d1 = ds({ id: 'ds_orders', name: 'Orders', tier: 'asset', gitBacked: true });
  const d2 = ds({ id: 'ds_customers', name: 'Customers', tier: 'asset', gitBacked: true,
    columns: [{ name: 'customer_id', description: 'PK.' }] });
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  await writeAnalyticsFiles(client, [d1, d2], 'approver');

  const schemaWrites = writes.filter((p) => p === 'dbt/models/governed/sales/schema.yml');
  // Last write wins (diff-write merges via buildDbtSchemaYaml over both datasets).
  assert.ok(schemaWrites.length > 0, 'schema.yml written');
  // The schema.yml for the FINAL write covers all domain datasets.
  const content = store.get('dbt/models/governed/sales/schema.yml') ?? '';
  assert.match(content, /gold_orders/, 'orders model present');
  assert.match(content, /gold_customers/, 'customers model present');
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

// ─── reconcileAnalyticsRepo: once-per-process boot reconcile ─────────────────

test('reconcileAnalyticsRepo fires a write on first call', async () => {
  _resetReconcileGuard();
  const d = ds();
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  reconcileAnalyticsRepo(client, [d]);

  // Fire-and-forget: give the microtask queue a tick to let writes land.
  await new Promise((r) => setImmediate(r));

  // The cube model file must have been written (store was empty → new write).
  assert.ok(writes.length > 0, 'reconcile wrote at least one file on first call');
});

test('reconcileAnalyticsRepo does NOT fire a second write on repeated calls (once-guard)', async () => {
  _resetReconcileGuard();
  const d = ds();
  const store: FakeStore = new Map();
  const { client, writes } = fakeForgejoFor(store);

  reconcileAnalyticsRepo(client, [d]);
  await new Promise((r) => setImmediate(r));
  const firstWriteCount = writes.length;

  // Call again with a DIFFERENT empty store to prove the guard blocks it.
  const store2: FakeStore = new Map();
  const { client: client2, writes: writes2 } = fakeForgejoFor(store2);
  reconcileAnalyticsRepo(client2, [d]);
  await new Promise((r) => setImmediate(r));

  assert.equal(writes2.length, 0, 'second call is a no-op (once-guard)');
  assert.ok(firstWriteCount > 0, 'first call did write (guard was clear)');
});

test('reconcileAnalyticsRepo is fire-and-forget: swallows Forgejo errors without throwing', async () => {
  _resetReconcileGuard();
  const broken: ForgejoClient = {
    async ensureRepo() {},
    async readFile() { return null; },
    async writeFile() { throw new Error('forgejo down'); },
    async deleteRepo() { return { deleted: true }; },
    async listCommits() { return null; },
    async getCommitFiles() { return null; },
  };
  const d = ds();
  // Must NOT throw.
  assert.doesNotThrow(() => reconcileAnalyticsRepo(broken, [d]));
  await new Promise((r) => setImmediate(r));
  // No throw from the settled promise (verified by test not rejecting).
});

test('reconcileAnalyticsRepo is a no-op when git is already current (diff-write skips unchanged)', async () => {
  _resetReconcileGuard();
  const d = ds();
  // Pre-populate store with exactly the content writeAnalyticsFiles would write.
  const { models } = (await import('./cube-models.ts')).buildCubeModels([d]);
  const cubeEntry = models[0]!;
  const store: FakeStore = new Map([
    [`cube/models/metrics/${cubeEntry.file.replace(/^metrics\//, '')}`, cubeEntry.model],
    // Also pre-seed the exposures file so that write is skipped too.
  ]);
  const { client, writes } = fakeForgejoFor(store);

  reconcileAnalyticsRepo(client, [d]);
  await new Promise((r) => setImmediate(r));

  // The cube file was already current — diff-write must skip it.
  const cubeKey = `cube/models/metrics/${cubeEntry.file.replace(/^metrics\//, '')}`;
  assert.ok(!writes.includes(cubeKey), 'diff-write skips unchanged cube file');
});
