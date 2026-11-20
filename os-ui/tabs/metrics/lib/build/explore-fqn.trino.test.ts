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
 * REAL TRINO: a metric reads the SAME physical table `get_dataset.queryable` names.
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
const DOMAIN = `it-kiekert-${sfx}`; // hyphenated like live domains; no schema of this name is ever created

/** A DOMAIN-tier (asset) dataset whose Gold lives in its owner's personal lane, like ds_i9kls75hdg. */
const dataset = () =>
  goldSales({ id: `ds_it_${sfx}`, name: 'Bestellpositionen', owner: OWNER, domain: DOMAIN, tier: 'asset', visibility: 'domain', viewNamespaced: true });
const tokenFor = (id: string) => viewerToken({ id, domains: [DOMAIN], role: 'creator', attributes: {} });
// Written out by hand, not computed by the code under test: the owner's lane, and the schema main
// derived from the domain name (`it-kiekert-…` → `it_kiekert_…`), which never exists here.
const personalTable = () => `iceberg.personal_${OWNER}.gold_bestellpositionen`;
const domainNamedTable = () => `iceberg.it_kiekert_${sfx}.gold_bestellpositionen`;

before(async () => {
  if (skip) return;
  // The owner builds their own lane (OPA allows a write to `personal_*` only for its owner).
  await trino(`CREATE SCHEMA iceberg.personal_${OWNER}`, OWNER);
  await trino(`CREATE TABLE ${personalTable()} (order_id integer, order_date date, region varchar, net_amount double)`, OWNER);
  await trino(
    `INSERT INTO ${personalTable()} VALUES (1, DATE '2026-11-01', 'DE', 10.5), (2, DATE '2026-11-02', 'FR', 20.0), (3, DATE '2026-11-02', 'DE', 1.5)`,
    OWNER,
  );
});

test('the metric reads queryable.fqn on real Trino and returns the real number (owner)', { skip }, async () => {
  const d = dataset();
  const r = await exploreMetric(d, d.measures[0], tokenFor(OWNER));
  assert.equal(r.mode, 'live (sql)');
  assert.ok(r.sql.includes(`FROM ${personalTable()}`), `the metric compiles the real table (queryable.fqn), got:\n${r.sql}`);
  assert.deepEqual(r.rows, [{ [r.member]: 32 }], 'Trino summed the three real rows');
});

test('a dashboard-style slice (dimension) over the same table also runs on real Trino', { skip }, async () => {
  const d = dataset();
  const r = await exploreMetric(d, d.measures[0], tokenFor(OWNER), { dimensions: ['region'] });
  const view = r.member.split('.')[0];
  const byRegion = Object.fromEntries(r.rows.map((row) => [row[`${view}.region`], row[r.member]]));
  assert.deepEqual(byRegion, { DE: 12, FR: 20 });
});

test('NEGATIVE TWIN: the old domain-name derivation is SCHEMA_NOT_FOUND on the same Trino', { skip }, async () => {
  // What main compiled: the schema taken from the domain name. It must fail here, or the fixture
  // would not reproduce the live defect and the test above would prove nothing.
  const d = dataset();
  const sql = previewTrinoSql(d, d.measures[0], exploreSpec(d, d.measures[0], {}), domainNamedTable())!;
  await assert.rejects(trino(sql, OWNER), (e: TrinoFailure) => e.errorName === 'SCHEMA_NOT_FOUND');
});

test("another viewer's read still goes through OPA: the owner's lane is denied to them", { skip }, async () => {
  const d = dataset();
  // For a non-owner the resolver names the domain copy, never someone else's personal lane, and the
  // metric runs AS them: they get Trino's answer for THEIR identity, never the owner's rows.
  await assert.rejects(exploreMetric(d, d.measures[0], tokenFor(OTHER)), (e: Error) => /does not exist/.test(e.message) && !e.message.includes(`personal_${OWNER}`));
  // OPA itself refuses the owner's table to that viewer.
  await assert.rejects(trino(`SELECT count(*) FROM ${personalTable()}`, OTHER), (e: TrinoFailure) => e.errorName === 'PERMISSION_DENIED');
});
