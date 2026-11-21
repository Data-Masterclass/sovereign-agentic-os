/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A sync schedule selects only the models the OS generated for its owner
 * USER STORY: As a data owner I want my schedule to run my models, not code another person added
 *             downstream of my landing table: that code needs its own schedule and owner.
 * ARCHITECTURE:
 *   - The allowed set is the OS-generated models of the schedule's owner, known from the dataset
 *     definitions, NOT from anything an author can write (a model's own `meta` is author-writable).
 *   - Native definitions (hash-checked, unpushable) select `<landing>.downstream() & <owner's models>`;
 *     `os/generated.yml` (unpushable) records the same owner-per-model map, which the run detective reads.
 *   - The legacy `os/schedules.yml` carries `models:` (the same list).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { DATA_LAYOUT } from '@core/infra/data-layout';
import { generateProjectReport } from '@tabs/data/lib/dbt/generate';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys, selectionForSync, selectionForBuild } from '@tabs/data/lib/dbt/asset-keys';

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return { version: '1', tier: 'dataset', visibility: 'private', folder: '/', description: '', versions: emptyVersions(), grants: [], measures: [], columns: [], viewNamespaced: true, ...input };
}
const sync = (id: string, owner: string, table: string) => ds({
  id, name: table, owner, domain: 'sales',
  sync: { connectionId: 'conn_shop', source: { schema: 'public', table }, mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' }, schedule: { cron: '0 * * * *' }, enabled: true },
  versions: { bronze: built(null), silver: built('silver/x.sql'), gold: built(null, true) },
});
const snap = (): ProjectSnapshot => ({
  domain: 'sales',
  datasets: [
    { dataset: sync('ds_alice001', 'alice', 'orders'), artifacts: { 'silver/x.sql': 'select 1' } },
    { dataset: sync('ds_bob00001', 'bob', 'events'), artifacts: { 'silver/x.sql': 'select 1' } },
  ],
  catalogs: { conn_shop: 'shop' },
});

test('the native schedule selects the landing\'s downstream only inside the owner\'s generated models', () => {
  const { files } = generateProjectReport('sales', snap());
  const py = files.get(DATA_LAYOUT.dagsterDefinitionsPath)!;
  const alice = py.split('\n').find((l) => /sales__ds_alice001 = dg\.define_asset_job/.test(l))!;
  // a database sync: the dlt landing's downstream, intersected with (the landing | the owner's dbt models by name)
  assert.match(alice, /\.downstream\(\) & \(dg\.AssetSelection\.assets\(\[[^)]*\]\) \| build_dbt_asset_selection\(\[sales_dbt\], dbt_select="/, alice);
  const owned = alice.slice(alice.indexOf('| build_dbt_asset_selection'));
  // exact FILE paths, never bare names (a model named like a directory must not select the directory)
  assert.match(owned, /dbt_select="path:models\/personal\/alice\/bronze_orders\.sql path:models\/personal\/alice\/gold_orders\.sql path:models\/personal\/alice\/silver_orders\.sql"/);
  assert.doesNotMatch(owned, /dbt_select="[^"]*(^|\s)[a-z_]+(\s|")/, 'no bare model name');
  assert.doesNotMatch(owned, /events/, 'bob\'s models are not in alice\'s set');
  assert.doesNotMatch(py, /dbt_select="[^"]*(config\.|meta|tag:)/, 'no author-writable selector (`meta`, `config`, `tag`) selects models');
});

test('os/generated.yml (unpushable) records which owner each generated model belongs to', () => {
  const { files } = generateProjectReport('sales', snap());
  const rec = yaml.load(files.get(DATA_LAYOUT.generatedHashesPath)!) as { owners?: Record<string, string> };
  assert.equal(rec.owners?.silver_orders, 'alice');
  assert.equal(rec.owners?.silver_events, 'bob');
  assert.equal(Object.keys(rec.owners ?? {}).includes('author_added_model'), false, 'only OS-generated models are listed');
});

test('os/owned-files.yml (unpushable, ALWAYS written) lists every generated model/test file with its owner', () => {
  const { files } = generateProjectReport('sales', snap());
  const f = (yaml.load(files.get(DATA_LAYOUT.ownedFilesPath)!) as { files: Record<string, string | null> }).files;
  assert.equal(f['models/personal/alice/silver_orders.sql'], 'alice', 'the receive gate reads the owner here');
  assert.equal(f['models/sources.yml'], null, 'a shared generated file has no owner');
  assert.equal(Object.keys(f).some((k) => k.startsWith('os/') || k.startsWith('data/') || k.startsWith('macros/')), false, 'the unpushable OS layer is not listed');
});

test('a domain with NO native definitions still gets os/owned-files.yml (the gate must not fail closed on it forever)', () => {
  const none: ProjectSnapshot = { domain: 'sales', datasets: [], catalogs: {} };
  const { files } = generateProjectReport('sales', none);
  assert.ok(files.has(DATA_LAYOUT.ownedFilesPath), [...files.keys()].join(','));
  assert.equal(files.has(DATA_LAYOUT.generatedHashesPath), false, 'os/generated.yml stays the native marker: unchanged');
});

test('the legacy schedules file lists the owner\'s models too', () => {
  const sched = yaml.load(generateProjectReport('sales', snap()).files.get('os/schedules.yml')!) as { schedules: { dataset: string; models?: string[] }[] };
  const a = sched.schedules.find((s) => s.dataset === 'ds_alice001')!;
  assert.deepEqual(a.models, ['bronze_orders', 'gold_orders', 'silver_orders']);
  assert.deepEqual((a as { paths?: string[] }).paths, ['models/personal/alice/bronze_orders.sql', 'models/personal/alice/gold_orders.sql', 'models/personal/alice/silver_orders.sql']);
});

test('NEGATIVE TWIN: a launch from the OS never selects another owner\'s dependent model', () => {
  const s: ProjectSnapshot = snap();
  // bob's dataset reads alice's: it is a dependent of alice's dataset, owned by someone else.
  s.datasets[1].dataset.upstreams = [{ datasetId: 'ds_alice001' } as never];
  const keys = datasetAssetKeys(s, 'ds_alice001');
  assert.deepEqual(keys.dependents, [], 'bob\'s model is not a dependent of alice\'s run');
  assert.ok(!selectionForSync(keys).some((k) => k.join('/').includes('events')));
  assert.ok(!selectionForBuild(keys, 'silver').some((k) => k.join('/').includes('events')));
});
