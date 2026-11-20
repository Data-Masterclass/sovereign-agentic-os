/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
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
import { goldSales } from '@tabs/metrics/lib/fixtures';
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';
import { builtLayerFqn } from '@tabs/data/lib/store';
import { domainSchema, physicalSlug } from '@tabs/data/lib/store-fqn';
import { previewTrinoSql, exploreSpec } from '@tabs/metrics/lib/explorer';
import { LH_TRINO_URL, trino, type TrinoFailure } from '@core/infra/trino-rest.test-helper';

const skip = LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';

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
const tokenFor = (id: string) => delegate(claimsFromUser({ id, domains: [DOMAIN], role: 'creator', attributes: {} }), 'domain');
const personalTable = () => `iceberg.personal_${OWNER}.gold_${physicalSlug(dataset())}`;

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
  const queryable = builtLayerFqn(d, { id: OWNER, domains: [DOMAIN], role: 'creator' }, 'gold');
  assert.equal(queryable?.fqn, personalTable(), 'fixture: the dataset resolver names the personal lane');

  const r = await exploreMetric(d, d.measures[0], tokenFor(OWNER));
  assert.equal(r.mode, 'live (sql)');
  assert.ok(r.sql.includes(`FROM ${queryable!.fqn}`), `the metric compiles the queryable FQN, got:\n${r.sql}`);
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
  const oldTarget = `iceberg.${domainSchema(d.domain)}.gold_${physicalSlug(d)}`;
  const sql = previewTrinoSql(d, d.measures[0], exploreSpec(d, d.measures[0], {}), oldTarget)!;
  await assert.rejects(trino(sql, OWNER), (e: TrinoFailure) => e.errorName === 'SCHEMA_NOT_FOUND');
});

test("another viewer's read still goes through OPA: the owner's lane is denied to them", { skip }, async () => {
  const d = dataset();
  // The resolver never names someone else's personal lane for a non-owner …
  assert.equal(builtLayerFqn(d, { id: OTHER, domains: [DOMAIN], role: 'creator' }, 'gold')?.fqn, `iceberg.${domainSchema(DOMAIN)}.gold_${physicalSlug(d)}`);
  // … and the metric for them runs AS them, so they get Trino's answer for THEIR identity, never the owner's rows.
  await assert.rejects(exploreMetric(d, d.measures[0], tokenFor(OTHER)), /SCHEMA_NOT_FOUND/);
  // OPA itself refuses the owner's table to that viewer.
  await assert.rejects(trino(`SELECT count(*) FROM ${personalTable()}`, OTHER), (e: TrinoFailure) => e.errorName === 'PERMISSION_DENIED');
});
