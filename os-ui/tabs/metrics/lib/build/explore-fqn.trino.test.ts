/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Real-Trino proof that a metric reads the table get_dataset.queryable names
 * USER STORY: As a viewer of a domain metric I want the number computed over the dataset's real
 *             table, so that a metric never fails on a schema derived from the domain name.
 * ARCHITECTURE:
 *   - Runs on the lakehouse harness (tests/lakehouse) through its own client (lib.mjs).
 *   - Only `queryRun` is replaced, by a pass-through to that Trino as the chosen principal.
 */
/**
 * REAL TRINO: a metric reads the SAME physical table `get_dataset.queryable` names — for a
 * governed dataset that is its DOMAIN copy, for every viewer including the owner.
 *
 * The live defect (0.9.22): a domain-tier dataset whose Gold lives in its owner's personal lane
 * reported `queryable.fqn = iceberg.personal_<owner>.gold_<slug>`, but `query_metric` compiled
 * `iceberg.<domain>.gold_<slug>` and Trino answered SCHEMA_NOT_FOUND. Here the same shape is built
 * on the chart's Trino 476 + OPA (tests/lakehouse): a personal-lane gold table, NO domain schema.
 *
 * Only `queryRun` is replaced, by a pass-through that sends the compiled SQL to that Trino AS the
 * principal os-ui chose (the query-tool's job). The SQL, the FQN and the identity are os-ui's own;
 * the answer and every access decision are Trino's and OPA's.
 *
 * Runs when LH_TRINO_URL is set (CI job test-lakehouse); skipped otherwise.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { goldSales, viewerToken } from '@tabs/metrics/lib/fixtures';
import { previewTrinoSql, exploreSpec } from '@tabs/metrics/lib/explorer';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../../../../../tests/lakehouse/lib.mjs';

type TrinoFailure = Error & { errorName?: string };
const trino = (sql: string, user: string): Promise<{ columns: string[]; rows: unknown[][] }> => run(sql, { user, source: 'os-ui-it' });
const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';

mock.module('@core/infra/governed', {
  namedExports: {
    queryRun: async (sql: string, principal?: string) => {
      const r = await trino(sql, principal ?? 'anonymous');
      return { engine: 'trino', tables: [], columns: r.columns, rows: r.rows.map((row) => row.map(String)), rowCount: r.rows.length };
    },
  },
});
mock.module('./live-clients.ts', { namedExports: { liveMetricsReachable: async () => true } });
const { exploreMetric } = await import('./explore-server.ts');

const sfx = Date.now().toString(36);
const OWNER = `it_owner_${sfx}`;
const OTHER = `it_viewer_${sfx}`;
const DOMAIN = `it-kiekert-${sfx}`; // hyphenated like live domains (schema it_kiekert_<sfx>)
const BUILT = `it-built-${sfx}`; // a second domain whose domain copy DOES exist

/** A DOMAIN-tier (asset) dataset whose Gold lives in its owner's personal lane, like ds_i9kls75hdg. */
const dataset = (domain = DOMAIN) =>
  goldSales({ id: `ds_it_${sfx}`, name: 'Bestellpositionen', owner: OWNER, domain, tier: 'asset', visibility: 'domain', viewNamespaced: true });
const tokenFor = (id: string, domain = DOMAIN) => viewerToken({ id, domains: [domain], role: 'creator', attributes: {} });
// Written out by hand, not computed by the code under test.
const personalTable = () => `iceberg.personal_${OWNER}.gold_bestellpositionen`;
const missingDomainTable = () => `iceberg.it_kiekert_${sfx}.gold_bestellpositionen`; // never created
const builtDomainTable = () => `iceberg.it_built_${sfx}.gold_bestellpositionen`;

before(async () => {
  if (skip) return;
  // The owner's lane holds a gold (the live Kiekert shape) …
  await trino(`CREATE SCHEMA iceberg.personal_${OWNER}`, OWNER);
  await trino(`CREATE TABLE ${personalTable()} (order_id integer, order_date date, region varchar, net_amount double)`, OWNER);
  await trino(`INSERT INTO ${personalTable()} VALUES (1, DATE '2026-11-01', 'DE', 10.5), (2, DATE '2026-11-02', 'FR', 20.0), (3, DATE '2026-11-02', 'DE', 1.5)`, OWNER);
  // … and for the second domain a DOMAIN copy exists, holding DIFFERENT rows than the lane, so a
  // read of the wrong table gives a different number.
  await trino(`CREATE SCHEMA iceberg.it_built_${sfx}`, OWNER);
  await trino(`CREATE TABLE ${builtDomainTable()} (order_id integer, order_date date, region varchar, net_amount double)`, OWNER);
  await trino(`INSERT INTO ${builtDomainTable()} VALUES (1, DATE '2026-11-01', 'DE', 100.0), (2, DATE '2026-11-02', 'FR', 7.0)`, OWNER);
});

test('the OWNER of an asset reads its DOMAIN copy on real Trino, not their lane', { skip }, async () => {
  const d = dataset(BUILT);
  const r = await exploreMetric(d, d.measures[0], tokenFor(OWNER, BUILT));
  assert.equal(r.mode, 'live (sql)');
  assert.ok(r.sql.includes(`FROM ${builtDomainTable()}`), `the metric compiles the domain copy, got:\n${r.sql}`);
  assert.deepEqual(r.rows, [{ [r.member]: 107 }], 'the domain copy\u2019s number (the lane would give 32)');
});

test('a dashboard-style slice over the domain copy also runs on real Trino; another viewer gets the same number', { skip }, async () => {
  const d = dataset(BUILT);
  const r = await exploreMetric(d, d.measures[0], tokenFor(OTHER, BUILT), { dimensions: ['region'] });
  const view = r.member.split('.')[0];
  const byRegion = Object.fromEntries(r.rows.map((row) => [row[`${view}.region`], row[r.member]]));
  assert.deepEqual(byRegion, { DE: 100, FR: 7 });
});

test('NO domain copy → a typed not_built naming the dataset; never a fallback to the lane', { skip }, async () => {
  const d = dataset(DOMAIN);
  await assert.rejects(exploreMetric(d, d.measures[0], tokenFor(OWNER)), (e: Error & { code?: string }) =>
    e.code === 'not_built' && e.message.includes(d.name) && e.message.includes(d.id) && e.message.includes(missingDomainTable()));
});

test('NEGATIVE TWIN: the lane really holds a different number, and the missing domain copy really is missing', { skip }, async () => {
  const d = dataset(DOMAIN);
  const laneSql = previewTrinoSql(d, d.measures[0], exploreSpec(d, d.measures[0], {}), personalTable())!;
  assert.equal(Number((await trino(laneSql, OWNER)).rows[0][0]), 32, 'reading the lane would give a number — the wrong one');
  const domSql = previewTrinoSql(d, d.measures[0], exploreSpec(d, d.measures[0], {}), missingDomainTable())!;
  await assert.rejects(trino(domSql, OWNER), (e: TrinoFailure) => e.errorName === 'SCHEMA_NOT_FOUND');
});

test("OPA still refuses the owner's lane to another viewer", { skip }, async () => {
  await assert.rejects(trino(`SELECT count(*) FROM ${personalTable()}`, OTHER), (e: TrinoFailure) => e.errorName === 'PERMISSION_DENIED');
});
