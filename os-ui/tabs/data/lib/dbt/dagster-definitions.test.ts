/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for WP-49 — Dagster definitions in the repo and no out-of-band layer
 * USER STORY: As a reviewer I want proof that the generator writes `data/dagster/definitions.py`
 *             with the dlt ingestion, the schedules and OS metadata only in tags; that the OS layer
 *             records the module's hash; that an authored silver becomes a dbt model adopting its
 *             table; and that a silver dbt could not rebuild is refused with a reason, never
 *             emitted as a source.
 * ARCHITECTURE: Pure — literal `Dataset` fixtures through `generateProjectReport`; the real Dagster,
 *             dbt, dlt and Trino run in images/extensions/dagster/tests/image/lakehouse.sh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { DATA_LAYOUT } from '@core/infra/data-layout';
import { generateProjectReport } from '@tabs/data/lib/dbt/generate';
import { planModels } from '@tabs/data/lib/dbt/models';
import { datasetAssetKeys, selectionForSync } from '@tabs/data/lib/dbt/asset-keys';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return { version: '1', tier: 'dataset', visibility: 'private', folder: '/', description: '', versions: emptyVersions(), grants: [], measures: [], columns: [], viewNamespaced: true, ...input };
}

const dbSync = () =>
  ds({
    id: 'ds_shop0001',
    name: 'Shop Orders',
    owner: 'alice',
    domain: 'sales',
    sync: { connectionId: 'conn_shop', source: { schema: 'public', table: 'orders' }, mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' }, schedule: { cron: '0 * * * *' }, enabled: true },
    versions: { bronze: built(null), silver: built('silver/shop.sql'), gold: built(null, true) },
  });

const snap = (artifacts: Record<string, string>, d = dbSync()): ProjectSnapshot => ({ domain: 'sales', datasets: [{ dataset: d, artifacts }], catalogs: { conn_shop: 'shop' } });

test('definitions.py is generated at the layout path and its sha256 is recorded in the OS layer', () => {
  const { files } = generateProjectReport('sales', snap({ 'silver/shop.sql': 'select * from iceberg.personal_alice.bronze_shop_orders' }));
  const py = files.get(DATA_LAYOUT.dagsterDefinitionsPath);
  assert.ok(py, 'data/dagster/definitions.py is generated');
  const rec = yaml.load(files.get(DATA_LAYOUT.generatedHashesPath)!) as { sha256: Record<string, string> };
  assert.equal(rec.sha256[DATA_LAYOUT.dagsterDefinitionsPath], createHash('sha256').update(py!).digest('hex'));
  assert.ok(!files.has('os/sources.yml'), 'no OS YAML is generated for Dagster to read');
});

test('a database sync is a dlt sql_table asset landing in landing_<domain>_<owner>, read by the sync model', () => {
  const { files } = generateProjectReport('sales', snap({ 'silver/shop.sql': 'select * from iceberg.personal_alice.bronze_shop_orders' }));
  const py = files.get(DATA_LAYOUT.dagsterDefinitionsPath)!;
  assert.match(py, /key=\["sales", "landing_sales_alice", "raw_shop_orders"\]/);
  assert.match(py, /sql_table\(\n\s+credentials=dlt\.secrets\["sources\.conn_shop\.credentials"\],\n\s+schema="public",\n\s+table="orders", incremental=dlt\.sources\.incremental\("updated_at"\),/);
  assert.match(py, /dlt\.pipeline\(pipeline_name="ds_shop0001", destination="sqlalchemy", dataset_name="landing_sales_alice"\)/);
  assert.match(py, /cron_schedule="0 \* \* \* \*"/);
  assert.match(py, /"os\/principal": "alice"/);
  const bronze = files.get('models/personal/alice/bronze_shop_orders.sql')!;
  assert.match(bronze, /source\('landing_sales_alice', 'raw_shop_orders'\)/);
  assert.doesNotMatch(bronze, /shop__public/, 'no federated catalog is read');
  // The OS's "sync now" launches the dlt ingestion too.
  const keys = datasetAssetKeys(snap({ 'silver/shop.sql': 'select 1' }), 'ds_shop0001');
  assert.deepEqual(selectionForSync(keys)[0], ['sales', 'landing_sales_alice', 'raw_shop_orders']);
});

test('OS metadata in definitions.py sits only inside tags= / metadata= (C2)', () => {
  const py = generateProjectReport('sales', snap({ 'silver/shop.sql': 'select 1' })).files.get(DATA_LAYOUT.dagsterDefinitionsPath)!;
  for (const line of py.split('\n')) {
    if (!/"os\//.test(line) || /^\s*#/.test(line)) continue;
    assert.match(line, /tags=\{|metadata=\{|run\.tags\.get\("os\//, `OS key outside tags/metadata: ${line}`);
  }
  assert.doesNotMatch(py, /os\/(schedules|sources|external)\.yml|import os\b/, 'definitions.py reads no OS file');
});

test('an AUTHORED silver is a dbt model that adopts its table (C3), never an out-of-band source', () => {
  const { files, skipped } = generateProjectReport('sales', snap({ 'silver/shop.sql': 'select id from iceberg.personal_alice.bronze_shop_orders' }));
  assert.deepEqual(skipped, []);
  const silver = files.get('models/personal/alice/silver_shop_orders.sql')!;
  assert.match(silver, /config\(materialized='table', on_table_exists='replace', full_refresh=false\)/);
  assert.match(silver, /select id from \{\{ ref\('bronze_shop_orders'\) \}\}/);
  assert.doesNotMatch(files.get('models/sources.yml') ?? '', /os_built|out-of-band/i);
});

test('NEGATIVE: a silver built outside dbt with no recorded SQL is refused with a reason (dbt could not rebuild it)', () => {
  const plan = planModels(snap({}));
  assert.deepEqual(plan.refused.map((r) => r.dataset), ['ds_shop0001']);
  const { files, skipped } = generateProjectReport('sales', snap({}));
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /silver layer is built but no SQL is recorded/);
  assert.ok(![...files.keys()].some((k) => k.includes('shop_orders')), 'the refused dataset contributes no file');
  assert.doesNotMatch(files.get('models/sources.yml') ?? '', /silver_shop_orders/, 'never emitted as a source');
  assert.match(files.get('os/skipped.yml')!, /ds_shop0001/);
});
