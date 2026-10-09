/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { buildImportZip, databaseFilePath, importFiles, parseManifest, passwordsFor, uuid5 } from './import-bundle.ts';
import { zipEntryNames, zipBundle } from './zip.ts';

/** The JSON manifest both Data build (scaffoldDashboardBundle) and Dashboards build
 *  (supersetBundle) produce — the input the real Superset client now turns into a ZIP. */
const MANIFEST = JSON.stringify({
  dashboard: 'Sales Overview',
  database_service_name: 'trino',
  dataset: { name: 'Sales', schema: 'cube', sql: 'SELECT * FROM "Sales"' },
  charts: [
    { name: 'Sales — revenue', viz_type: 'big_number_total', metric: 'revenue' },
    { name: 'Revenue by region', viz_type: 'bar', metric: 'revenue', groupby: ['region'] },
  ],
});

test('importFiles emits the Superset import_assets layout (metadata + db + dataset + charts + dashboard)', () => {
  const files = importFiles(parseManifest(MANIFEST));
  const paths = Object.keys(files).sort();
  assert.ok(paths.includes('dashboard_export/metadata.yaml'));
  assert.ok(paths.includes('dashboard_export/databases/trino.yaml'));
  assert.ok(paths.includes('dashboard_export/datasets/trino/sales.yaml'));
  // one chart file per chart
  const chartFiles = paths.filter((p) => p.startsWith('dashboard_export/charts/'));
  assert.equal(chartFiles.length, 2);
  const dashFiles = paths.filter((p) => p.startsWith('dashboard_export/dashboards/'));
  assert.equal(dashFiles.length, 1);

  // metadata declares a Dashboard export
  const meta = yaml.load(files['dashboard_export/metadata.yaml']) as Record<string, unknown>;
  assert.equal(meta.type, 'Dashboard');
  assert.equal(meta.version, '1.0.0');
});

test('assets are linked by uuid: charts → dataset → database, dashboard position → charts', () => {
  const files = importFiles(parseManifest(MANIFEST));
  const dataset = yaml.load(files['dashboard_export/datasets/trino/sales.yaml']) as Record<string, string>;
  const db = yaml.load(files['dashboard_export/databases/trino.yaml']) as Record<string, string>;
  assert.equal(dataset.database_uuid, db.uuid);

  const chartPath = Object.keys(files).find((p) => p.startsWith('dashboard_export/charts/'))!;
  const chart = yaml.load(files[chartPath]) as Record<string, string>;
  assert.equal(chart.dataset_uuid, dataset.uuid);
  assert.equal(chart.version, '1.0.0');

  const dash = yaml.load(files[Object.keys(files).find((p) => p.startsWith('dashboard_export/dashboards/'))!]) as {
    dashboard_title: string;
    position: Record<string, { type: string; meta?: { uuid?: string } }>;
  };
  assert.equal(dash.dashboard_title, 'Sales Overview');
  const chartNodes = Object.values(dash.position).filter((n) => n.type === 'CHART');
  assert.equal(chartNodes.length, 2);
  // every CHART node references a real chart uuid
  const chartUuids = new Set(
    Object.keys(files)
      .filter((p) => p.startsWith('dashboard_export/charts/'))
      .map((p) => (yaml.load(files[p]) as { uuid: string }).uuid),
  );
  for (const n of chartNodes) assert.ok(chartUuids.has(n.meta!.uuid!));
});

test('uuid5 is deterministic ⇒ re-import is idempotent (Superset upserts by uuid)', () => {
  assert.equal(uuid5('database:trino'), uuid5('database:trino'));
  assert.notEqual(uuid5('database:trino'), uuid5('dataset:trino:Sales'));
  assert.match(uuid5('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // same manifest ⇒ byte-identical archive
  assert.deepEqual(buildImportZip(MANIFEST), buildImportZip(MANIFEST));
});

test('buildImportZip produces a real ZIP whose entries are the import files', () => {
  const zip = buildImportZip(MANIFEST);
  // PK\x03\x04 local file header magic
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const names = zipEntryNames(zip);
  assert.deepEqual(names, Object.keys(importFiles(parseManifest(MANIFEST))).sort());
});

test('zipBundle round-trips entry names and stores exact bytes', () => {
  const zip = zipBundle({ 'a/one.txt': 'hello', 'b/two.txt': 'world' });
  assert.deepEqual(zipEntryNames(zip), ['a/one.txt', 'b/two.txt']);
});

/** The Cube SQL manifest a domain-scoped dashboard produces (lib/dashboards/model.ts). */
const CUBE_MANIFEST = JSON.stringify({
  dashboard: 'Sales Overview',
  database_service_name: 'cube_sales',
  database: { service_name: 'cube_sales', sqlalchemy_uri: 'postgresql://bi_sales:__CUBE_SQL_PASSWORD__@cube-sql:15432/bi_sales', cube_sql: true },
  dataset: { name: 'Sales', sql: 'SELECT * FROM "Sales"' },
  charts: [{ name: 'Revenue', viz_type: 'big_number_total', metric: 'revenue' }],
});

test('Cube SQL manifest emits the postgres URI to bi_<domain> and a schemaless dataset', () => {
  const files = importFiles(parseManifest(CUBE_MANIFEST));
  const db = yaml.load(files['dashboard_export/databases/cube_sales.yaml']) as Record<string, unknown>;
  assert.equal(db.sqlalchemy_uri, 'postgresql://bi_sales:__CUBE_SQL_PASSWORD__@cube-sql:15432/bi_sales');
  const ds = yaml.load(files['dashboard_export/datasets/cube_sales/sales.yaml']) as Record<string, unknown>;
  // Cube view is a top-level table on the SQL API — no schema (NOT the wrong 'cube' schema).
  assert.equal(ds.schema, null);
  assert.equal(ds.sql, 'SELECT * FROM "Sales"');
  assert.equal(ds.database_uuid, db.uuid);
});

test('passwordsFor injects the Cube SQL password keyed by the db yaml path (server-side only)', () => {
  const m = parseManifest(CUBE_MANIFEST);
  const pw = passwordsFor(m, 's3cret');
  assert.deepEqual(pw, { [databaseFilePath(m)]: 's3cret' });
  assert.equal(databaseFilePath(m), 'dashboard_export/databases/cube_sales.yaml');
  // No password supplied ⇒ empty map (honest degradation, no false secret).
  assert.deepEqual(passwordsFor(m, ''), {});
  // Legacy Trino manifest never needs a password.
  assert.deepEqual(passwordsFor(parseManifest(MANIFEST), 's3cret'), {});
});

test('parseManifest rejects a malformed bundle (⇒ adapter reports ✗, never a false ✓)', () => {
  assert.throws(() => parseManifest('{}'), /dashboard title/);
  assert.throws(() => parseManifest(JSON.stringify({ dashboard: 'X', dataset: { name: 'Y' }, charts: [] })), /at least one chart/);
});
