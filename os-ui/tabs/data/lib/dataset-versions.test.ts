/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Unit proof of the per-dataset rule and the SQL guards behind dataset versions (WP-37)
 * USER STORY: As a data owner I want a restore or a tag to act on my dataset's own table only,
 *             and never on a table another dataset (archived or not) also maps to.
 * ARCHITECTURE: store + resolvers in memory; the Trino/Polaris hop is proven in
 *               dataset-versions.trino.test.ts.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore, __seedDatasetForTest, archiveDataset, buildVersion, createDataset, getDataset, listAllDatasets,
  type Principal,
} from '@tabs/data/lib/store';
import { datasetTables, resolveVersionTable, rollbackVersion, VersionTableError, type VersionDeps } from '@tabs/data/lib/dataset-versions';
import {
  configuredRetention, diffCountsSql, expireSnapshotsSql, parseFqn, readAtVersionSql, refName, retention,
  rollbackSql, snapshotId, snapshotsSql, versionClause,
} from '@tabs/data/lib/iceberg-sql';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const all = () => listAllDatasets({ includeArchived: true });

beforeEach(() => __resetStore());

function built(id: string, layers: ('bronze' | 'silver' | 'gold')[] = ['bronze']) {
  for (const l of layers) buildVersion(id, amir, l, { quality: 'passing', artifact: `${l}/${id}.sql`, ...(l === 'bronze' ? {} : { passThrough: true }) });
}

test('a dataset with its own lane name resolves to its own table and nothing else maps there', () => {
  const d = createDataset(amir, { name: 'Goods Receipts', domain: 'sales' });
  built(d.id);
  const t = resolveVersionTable(getDataset(d.id, amir), amir, all(), { intent: 'write' });
  assert.match(t.fqn, /^iceberg\.personal_amir\.bronze_goods_receipts_[a-z0-9]+$/);
  assert.equal(t.principal, 'amir');
  assert.equal(t.legacyLane, false);
});

test('two datasets on one legacy table: versions refused for BOTH, an archived sibling included', () => {
  __seedDatasetForTest({ id: 'ds_a1', name: 'Northpeak Goods Receipts', owner: 'amir', domain: 'sales' });
  __seedDatasetForTest({ id: 'ds_b2', name: 'Northpeak Goods Receipts', owner: 'amir', domain: 'sales' });
  built('ds_a1');
  built('ds_b2');
  archiveDataset('ds_b2', amir);
  for (const intent of ['read', 'write'] as const) {
    assert.throws(
      () => resolveVersionTable(getDataset('ds_a1', amir), amir, all(), { intent }),
      (e: unknown) => e instanceof VersionTableError && e.code === 'shared_table'
        && (e.detail.siblings as { id: string; archived: boolean }[]).some((s) => s.id === 'ds_b2' && s.archived),
    );
  }
});

test('a legacy lane with no sibling is listed but never restored or tagged', () => {
  __seedDatasetForTest({ id: 'ds_old', name: 'Old Orders', owner: 'amir', domain: 'sales' });
  built('ds_old');
  const t = resolveVersionTable(getDataset('ds_old', amir), amir, all(), { intent: 'read' });
  assert.equal(t.legacyLane, true);
  assert.throws(() => resolveVersionTable(getDataset('ds_old', amir), amir, all(), { intent: 'write' }), /name-only lane table/);
});

test('a refused restore sends NOTHING to Trino (the shared table is never touched)', async () => {
  __seedDatasetForTest({ id: 'ds_a1', name: 'Receipts', owner: 'amir', domain: 'sales' });
  __seedDatasetForTest({ id: 'ds_b2', name: 'Receipts', owner: 'amir', domain: 'sales' });
  built('ds_a1');
  built('ds_b2');
  const sent: string[] = [];
  const deps: VersionDeps = {
    query: async (sql) => { sent.push(sql); return { rows: [] }; },
    execute: async (sql) => { sent.push(sql); },
    createRef: async () => { sent.push('createRef'); },
  };
  await assert.rejects(rollbackVersion(getDataset('ds_a1', amir), amir, all(), deps, { snapshotId: '42' }), /also mapped by/);
  assert.deepEqual(sent, []);
});

test('datasetTables covers lane and domain copies of every layer', () => {
  const d = createDataset(amir, { name: 'Orders', domain: 'sales' });
  const ts = [...datasetTables(getDataset(d.id, amir))];
  assert.ok(ts.includes('iceberg.sales.gold_orders'));
  assert.ok(ts.some((t) => /^iceberg\.personal_amir\.silver_orders_/.test(t)));
  assert.equal(ts.length, 6);
});

test('not built → not_built, never a guessed table', () => {
  const d = createDataset(amir, { name: 'Empty', domain: 'sales' });
  assert.throws(() => resolveVersionTable(getDataset(d.id, amir), amir, all()), (e: unknown) => e instanceof VersionTableError && e.code === 'not_built');
});

test('SQL guards: identifiers, snapshot ids, ref names and retention are validated before any text is built', () => {
  assert.throws(() => parseFqn('iceberg.sales.t; drop table x'), /not a catalog/);
  assert.throws(() => parseFqn('iceberg."sales".t'), /not a catalog/);
  assert.throws(() => snapshotId('1 or 1=1'), /snapshot id/);
  assert.throws(() => snapshotId('99999999999999999999'), /snapshot id/);
  assert.throws(() => refName("x' OR '1'='1"), /valid tag/);
  assert.throws(() => refName('main'), /current branch/);
  assert.throws(() => retention('0d'), /retention/);
  assert.throws(() => retention("7d') , x => ('"), /retention/);
  assert.equal(versionClause({ snapshotId: '8954597067493422955' }), 'FOR VERSION AS OF 8954597067493422955');
  assert.equal(versionClause({ ref: 'promoted-ap_12' }), "FOR VERSION AS OF 'promoted-ap_12'");
  assert.equal(rollbackSql('iceberg.sales.gold_x', '123'), 'ALTER TABLE iceberg.sales.gold_x EXECUTE rollback_to_snapshot(123)');
  assert.equal(expireSnapshotsSql('iceberg.sales.gold_x', '14d'), "ALTER TABLE iceberg.sales.gold_x EXECUTE expire_snapshots(retention_threshold => '14d')");
  assert.match(snapshotsSql('iceberg.sales.gold_x'), /FROM iceberg\.sales\."gold_x\$snapshots"/);
  assert.match(snapshotsSql('iceberg.sales.gold_x'), /CAST\(snapshot_id AS varchar\)/);
  assert.match(diffCountsSql('iceberg.sales.gold_x', { ref: 'a' }, { snapshotId: '2' }), /EXCEPT ALL/);
  assert.match(readAtVersionSql('iceberg.sales.gold_x', { ref: 'a' }, 999999), /LIMIT 10000$/);
});

test('retention is configurable and defaults to 7d', () => {
  assert.equal(configuredRetention({}), '7d');
  assert.equal(configuredRetention({ OS_ICEBERG_SNAPSHOT_RETENTION: '30d' }), '30d');
  assert.throws(() => configuredRetention({ OS_ICEBERG_SNAPSHOT_RETENTION: 'forever' }), /retention/);
});
