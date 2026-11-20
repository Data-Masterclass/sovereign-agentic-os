/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Real proof that a dataset version IS an Iceberg snapshot, a named version IS an
 *             Iceberg tag or branch, and restore/expiry never touch another dataset's table (WP-37)
 * USER STORY: As a data owner I want to list, compare, restore and pin versions of my dataset, and
 *             I want plain Trino to see exactly the same versions with no OS in between.
 * ARCHITECTURE:
 *   - Runs on the lakehouse harness (tests/lakehouse: the chart's Trino 476, Polaris 1.1, MinIO,
 *     OPA, plus the data-runner built from this checkout). Reads and writes go to Trino through the
 *     harness client; tags and branches go through the data-runner's PyIceberg commit to Polaris.
 *   - The calls are os-ui's own (`dataset-versions.ts`); the FQNs come from the store and resolvers.
 *   - Negative twins: a tag that exists only in the OS is invisible to Trino; expiry really ran
 *     (an untagged old snapshot is gone), so "the tagged one survived" is not vacuous; a refused
 *     restore on a shared table leaves that table exactly as it was.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore, __seedDatasetForTest, archiveDataset, buildVersion, createDataset, getDataset, listAllDatasets,
  type Principal,
} from '@tabs/data/lib/store';
import { versionTarget } from '@tabs/data/lib/store-fqn';
import { passThroughPlan } from '@tabs/data/lib/transform';
import {
  diffVersions, listVersions, nameVersion, rollbackVersion, VersionTableError, type VersionDeps,
} from '@tabs/data/lib/dataset-versions';
import { expireSnapshotsSql } from '@tabs/data/lib/iceberg-sql';
import { authorize } from '@core/infra/governed';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../../../../tests/lakehouse/lib.mjs';

const skip = process.env.LH_TRINO_URL && process.env.OPA_URL ? false : 'LH_TRINO_URL / OPA_URL not set (start tests/lakehouse/up.sh)';
const RUNNER = process.env.LH_RUNNER_URL ?? 'http://127.0.0.1:18000';
const trino = (sql: string, user: string): Promise<{ rows: unknown[][]; columns: string[] }> => run(sql, { user, source: 'os-ui-it' });

const sfx = Date.now().toString(36);
const OWNER = `it_ver_${sfx}`;
const DOM = `it-ver-dom-${sfx}`;
const owner: Principal = { id: OWNER, domains: [DOM], role: 'creator' };
const identity = { uid: OWNER, domains: owner.domains };

/** The side effects, as `who`: Trino reads/writes, the data-runner ref commit, and the chart's OPA
 *  (`agentic.authz.data_version_write`) for the write decision — every hop real. */
const depsAs = (who: Principal): VersionDeps => ({
  query: (sql, principal) => trino(sql, principal),
  execute: async (sql, w) => { await trino(sql, w.principal); },
  createRef: async (body) => {
    const res = await fetch(`${RUNNER}/refs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) throw new Error(`data-runner /refs ${res.status}: ${data.error ?? ''}`);
  },
  authorizeWrite: async (input) => (await authorize(`user:${who.id}`, 'data.version.write', { rule: 'data_version_write', input })).allowed,
});
const deps = depsAs(owner);

const all = () => listAllDatasets({ includeArchived: true });
const rowsOf = async (sql: string) => (await trino(sql, OWNER)).rows.map((r) => r.map(String).join('|')).sort();

let dsId = '';
let gold = '';
const snaps: string[] = []; // oldest first: after build, +2 rows, +1 row

before(async () => {
  if (skip) return;
  __resetStore();
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.personal_${OWNER}`, OWNER);
  const d = createDataset(owner, { name: 'Goods Receipts', domain: DOM });
  dsId = d.id;
  const bronze = versionTarget(getDataset(d.id, owner), 'bronze', owner);
  await trino(`CREATE TABLE ${bronze} AS SELECT * FROM (VALUES ('a', 1), ('b', 2)) AS t(src, n)`, OWNER);
  buildVersion(d.id, owner, 'bronze', { quality: 'passing', artifact: `bronze/${d.id}.dlt.yml` });
  await trino(passThroughPlan(getDataset(d.id, owner), identity, 'silver').sql, OWNER);
  buildVersion(d.id, owner, 'silver', { quality: 'passing', artifact: `silver/${d.id}.sql`, passThrough: true });
  await trino(passThroughPlan(getDataset(d.id, owner), identity, 'gold').sql, OWNER);
  buildVersion(d.id, owner, 'gold', { quality: 'passing', artifact: `gold/${d.id}.sql`, passThrough: true });
  gold = versionTarget(getDataset(d.id, owner), 'gold', owner);
  const last = async () => String((await trino(`SELECT CAST(snapshot_id AS varchar) FROM ${gold.replace(/\.([a-z0-9_]+)$/, '."$1$snapshots"')} ORDER BY committed_at DESC LIMIT 1`, OWNER)).rows[0][0]);
  snaps.push(await last());
  await trino(`INSERT INTO ${gold} VALUES ('c', 3), ('d', 4)`, OWNER);
  snaps.push(await last());
  await trino(`INSERT INTO ${gold} VALUES ('e', 5)`, OWNER);
  snaps.push(await last());
});

test('a dataset version is an Iceberg snapshot of ITS table, read as the viewer', { skip }, async () => {
  const v = await listVersions(getDataset(dsId, owner), owner, all(), deps, 'gold');
  assert.equal(v.table, gold);
  assert.equal(v.current, snaps[2], 'current = the main branch');
  for (const s of snaps) assert.ok(v.versions.some((x) => x.snapshotId === s), `snapshot ${s} is listed`);
  assert.equal(v.versions[0].snapshotId, snaps[2], 'newest first');
  assert.ok(/^[0-9]{12,}$/.test(snaps[0]), 'ids are carried as exact strings (they exceed 2^53)');
});

test('a tag and a branch are committed to the catalog, and plain Trino reads them (eject)', { skip }, async () => {
  const d = getDataset(dsId, owner);
  await nameVersion(d, owner, all(), deps, { snapshotId: snaps[0], name: 'first-build', kind: 'tag', layer: 'gold' });
  await nameVersion(d, owner, all(), deps, { snapshotId: snaps[1], name: 'audit', kind: 'branch', layer: 'gold' });

  // Eject: plain SQL any Trino (or Spark) user would type; no OS code builds these strings.
  const [, sch, tbl] = gold.split('.');
  const refs = (await trino(`SELECT name, type, CAST(snapshot_id AS varchar), max_reference_age_in_ms FROM iceberg.${sch}."${tbl}$refs" ORDER BY name`, OWNER)).rows;
  assert.deepEqual(refs.map((r) => [r[0], r[1], r[2]]), [['audit', 'BRANCH', snaps[1]], ['first-build', 'TAG', snaps[0]], ['main', 'BRANCH', snaps[2]]]);
  assert.equal(refs.find((r) => r[0] === 'first-build')![3], null, 'the tag has no max age: it never ages out');
  assert.deepEqual(await rowsOf(`SELECT src, n FROM iceberg.${sch}.${tbl} FOR VERSION AS OF 'first-build'`), ['a|1', 'b|2']);
  assert.deepEqual(await rowsOf(`SELECT src, n FROM iceberg.${sch}.${tbl} FOR VERSION AS OF 'audit'`), ['a|1', 'b|2', 'c|3', 'd|4']);

  // Negative twin: a name the catalog never committed does not resolve, so a tag kept only in
  // the OS would be invisible to every engine.
  await assert.rejects(trino(`SELECT 1 FROM iceberg.${sch}.${tbl} FOR VERSION AS OF 'only-in-the-os'`, OWNER));
  // A taken name is refused, not moved.
  await assert.rejects(nameVersion(d, owner, all(), deps, { snapshotId: snaps[2], name: 'first-build', layer: 'gold' }), /already names/);
});

test('diff_dataset_data: rows added and removed between two versions (EXCEPT ALL on time travel)', { skip }, async () => {
  const diff = await diffVersions(getDataset(dsId, owner), owner, all(), deps, { from: 'first-build', to: snaps[2], layer: 'gold' });
  assert.equal(diff.added, 3);
  assert.equal(diff.removed, 0);
  assert.deepEqual(diff.rows.map((r) => r.map(String).join('|')).sort(), ['+|c|3', '+|d|4', '+|e|5']);
});

test('restore = rollback_to_snapshot; expiry keeps tagged versions and drops untagged ones', { skip }, async () => {
  const d = getDataset(dsId, owner);
  const r = await rollbackVersion(d, owner, all(), deps, { snapshotId: snaps[0], layer: 'gold' });
  assert.equal(r.current, snaps[0]);
  assert.deepEqual(await rowsOf(`SELECT src, n FROM ${gold}`), ['a|1', 'b|2'], 'the table reads the restored version');
  await assert.rejects(rollbackVersion(d, owner, all(), deps, { snapshotId: '1234567890123', layer: 'gold' }), /not a version/);

  // Expire everything older than "now" that no ref holds (the harness lowers Trino's 7 d floor;
  // the OS itself only ever sends the configured retention, see iceberg-sql.retention).
  await trino(expireSnapshotsSql(gold, '1h').replace("'1h'", "'0s'"), OWNER);
  const [, sch, tbl] = gold.split('.');
  assert.deepEqual(await rowsOf(`SELECT src, n FROM iceberg.${sch}.${tbl} FOR VERSION AS OF 'first-build'`), ['a|1', 'b|2'], 'the tagged version survived');
  assert.deepEqual(await rowsOf(`SELECT src, n FROM iceberg.${sch}.${tbl} FOR VERSION AS OF 'audit'`), ['a|1', 'b|2', 'c|3', 'd|4'], 'the branch survived');
  // Negative twin: expiry really ran — the untagged snapshot that was current before the restore is gone.
  await assert.rejects(trino(`SELECT 1 FROM iceberg.${sch}.${tbl} FOR VERSION AS OF ${snaps[2]}`, OWNER));
  const left = (await listVersions(getDataset(dsId, owner), owner, all(), deps, 'gold')).versions.map((v) => v.snapshotId);
  assert.ok(!left.includes(snaps[2]));
});

test('a table another dataset maps to (an archived sibling too) is never restored', { skip }, async () => {
  // Two LEGACY datasets (no unique lane name) of one owner and one name: one lane table, as on
  // 18 Nov when a draft overwrote personal_aborek.gold_northpeak_goods_receipts.
  const A = `ds_legacya${sfx}`;
  const B = `ds_legacyb${sfx}`;
  __seedDatasetForTest({ id: A, name: 'Northpeak Receipts', owner: OWNER, domain: DOM });
  __seedDatasetForTest({ id: B, name: 'Northpeak Receipts', owner: OWNER, domain: DOM });
  const shared = versionTarget(getDataset(A, owner), 'bronze', owner);
  assert.equal(shared, versionTarget(getDataset(B, owner), 'bronze', owner), 'the trap: one table');
  await trino(`CREATE TABLE ${shared} AS SELECT * FROM (VALUES ('A', 1)) AS t(src, n)`, OWNER);
  const first = String((await trino(`SELECT CAST(snapshot_id AS varchar) FROM ${shared.replace(/\.([a-z0-9_]+)$/, '."$1$snapshots"')} ORDER BY committed_at LIMIT 1`, OWNER)).rows[0][0]);
  await trino(`INSERT INTO ${shared} VALUES ('B', 2)`, OWNER);
  buildVersion(A, owner, 'bronze', { quality: 'passing', artifact: `bronze/${A}.dlt.yml` });
  buildVersion(B, owner, 'bronze', { quality: 'passing', artifact: `bronze/${B}.dlt.yml` });
  archiveDataset(B, owner);

  for (const call of [
    () => rollbackVersion(getDataset(A, owner), owner, all(), deps, { snapshotId: first, layer: 'bronze' }),
    () => nameVersion(getDataset(A, owner), owner, all(), deps, { snapshotId: first, name: 'mine', layer: 'bronze' }),
    () => listVersions(getDataset(A, owner), owner, all(), deps, 'bronze'),
  ]) {
    await assert.rejects(call(), (e: unknown) => e instanceof VersionTableError && e.code === 'shared_table' && /archived/.test(e.message));
  }
  assert.deepEqual(await rowsOf(`SELECT src, n FROM ${shared}`), ['A|1', 'B|2'], 'the shared table is untouched');
  const [, sch, tbl] = shared.split('.');
  assert.deepEqual((await trino(`SELECT name FROM iceberg.${sch}."${tbl}$refs"`, OWNER)).rows, [['main']], 'no tag was written');
});

test('a Domain dataset is restored by a domain_admin of its domain, never by a builder (real OPA)', { skip }, async () => {
  const ID = `ds_govasset${sfx}`;
  __seedDatasetForTest({ id: ID, name: 'Governed Receipts', owner: OWNER, domain: DOM, tier: 'asset' });
  buildVersion(ID, owner, 'gold', { quality: 'passing', artifact: `gold/${ID}.sql`, passThrough: true });
  const table = versionTarget(getDataset(ID, owner), 'gold', owner);
  assert.match(table, /^iceberg\.it_ver_dom_[a-z0-9_]+\.gold_governed_receipts$/, 'served from the domain copy');
  const schema = table.split('.').slice(0, 2).join('.');
  await trino(`CREATE SCHEMA IF NOT EXISTS ${schema}`, OWNER);
  await trino(`CREATE TABLE ${table} AS SELECT * FROM (VALUES ('v1', 1)) AS t(src, n)`, OWNER);
  const first = String((await trino(`SELECT CAST(snapshot_id AS varchar) FROM ${table.replace(/\.([a-z0-9_]+)$/, '."$1$snapshots"')} ORDER BY committed_at LIMIT 1`, OWNER)).rows[0][0]);
  await trino(`INSERT INTO ${table} VALUES ('v2', 2)`, OWNER);

  const builder: Principal = { id: OWNER, domains: [DOM], role: 'builder' }; // the dataset's own owner, a builder
  const domainAdmin: Principal = { id: `it_dadmin_${sfx}`, domains: [DOM], role: 'domain_admin' };
  const otherAdmin: Principal = { id: `it_oadmin_${sfx}`, domains: ['elsewhere'], role: 'domain_admin' };

  // Negative twins: a builder (even the owner) and a domain_admin of ANOTHER domain are refused by
  // OPA, before anything reaches Trino or the catalog.
  for (const who of [builder, otherAdmin]) {
    await assert.rejects(rollbackVersion(getDataset(ID, owner), who, all(), depsAs(who), { snapshotId: first }),
      (e: unknown) => e instanceof VersionTableError && e.code === 'forbidden');
    await assert.rejects(nameVersion(getDataset(ID, owner), who, all(), depsAs(who), { snapshotId: first, name: 'nope' }),
      (e: unknown) => e instanceof VersionTableError && e.code === 'forbidden');
  }
  assert.deepEqual(await rowsOf(`SELECT src, n FROM ${table}`), ['v1|1', 'v2|2'], 'refused: the table is unchanged');
  const [, sch, tbl] = table.split('.');
  assert.deepEqual((await trino(`SELECT name FROM iceberg.${sch}."${tbl}$refs"`, OWNER)).rows, [['main']], 'refused: no tag written');

  // The domain_admin of the dataset's domain may. The OS decision is OPA's (above); the Trino session
  // runs as the harness user that created this domain schema (the per-person Trino identity is WP-35).
  const asSchemaOwner = { ...depsAs(domainAdmin), query: (sql: string) => trino(sql, OWNER), execute: async (sql: string) => { await trino(sql, OWNER); } };
  const ok = await rollbackVersion(getDataset(ID, owner), domainAdmin, all(), asSchemaOwner, { snapshotId: first });
  assert.equal(ok.current, first);
  assert.deepEqual(await rowsOf(`SELECT src, n FROM ${table}`), ['v1|1']);
});
