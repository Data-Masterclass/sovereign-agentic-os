// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-14 parity: the cut-over changes HOW a client reaches Trino, never WHAT a viewer sees.
// Today the query-tool connects over plain HTTP with the session user set to the principal os-ui
// chose (a uid, a domain principal or a service principal). After the cut-over it connects over
// TLS as `svc-os-ui` and impersonates that same principal. Trino's OPA row filters and column
// masks key on the session user, so every viewer must get byte-identical rows on both paths.
//
// The governance documents are the ones os-ui writes today (`governance/tables/<fqn>`,
// `governance/principals/<id>`; os-ui/tabs/data/lib/policy/opa-state-writes.ts). Phase 1 (dual-run
// render) runs both paths side by side and stores the legacy answers in the harness work dir;
// phase 2 (closed render, LH_EXPECT_HTTP=refused) has no plain-HTTP path any more and compares
// the TLS answers with the stored phase-1 legacy answers. The expected results are also asserted
// directly, so parity can never hold vacuously (e.g. everyone seeing nothing).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './lib.mjs';
import { requireSecrets, wp14Skip, runTls, opaPut, workDir } from './tls.mjs';

const skip = wp14Skip();
const closed = process.env.LH_EXPECT_HTTP === 'refused';
const S = 'parity_wp14';
const D1 = 'parity-d1';
const D2 = 'parity-d2';
const ALICE = 'alice.parity@x.com'; // D1 member with the pii clearance
const CAROL = 'carol.parity@x.com'; // D1 member without pii
const BOB = 'bob.parity@x.com'; // D2 member
const LANE = 'personal_alice_parity_x_com';
const VIEWERS = [ALICE, CAROL, BOB, D1, D2];

const QUERIES = {
  current_user: 'SELECT current_user',
  orders: `SELECT id, region, email FROM iceberg.${S}.orders ORDER BY id`,
  shared: `SELECT k, v FROM iceberg.${S}.kpis ORDER BY k`,
  public: `SELECT x FROM iceberg.${S}.ref ORDER BY x`,
  lane: `SELECT n FROM iceberg.${LANE}.notes ORDER BY n`,
  count: `SELECT count(*), count(email) FROM iceberg.${S}.orders`,
};

const tables = {
  [`iceberg.${S}.orders`]: { domain: D1, visibility: 'domain', shared_with: [], shared_with_users: [], sensitive_columns: { email: 'pii' } },
  [`iceberg.${S}.kpis`]: { domain: D1, visibility: 'shared', shared_with: [D2], shared_with_users: [], sensitive_columns: {} },
  [`iceberg.${S}.ref`]: { domain: D1, visibility: 'public', shared_with: [], shared_with_users: [], sensitive_columns: {} },
};
const principals = {
  [ALICE]: { domains: [D1], clearances: ['pii'] },
  [CAROL]: { domains: [D1], clearances: [] },
  [BOB]: { domains: [D2], clearances: [] },
  [D1]: { domains: [D1], clearances: [] },
  [D2]: { domains: [D2], clearances: [] },
};

const baselineFile = () => join(workDir(), 'parity-baseline.json');

/** A row set, or the error class Trino answered with (a denial is an answer too). */
async function answer(fn) {
  try {
    return { rows: (await fn()).rows };
  } catch (e) {
    if (e.errorName) return { error: e.errorName };
    throw e;
  }
}
const legacy = (sql, viewer) => answer(() => run(sql, { user: viewer, source: 'os-ui/parity/query' }));
const viaTls = (sql, viewer) => answer(() => runTls(sql, { auth: ['svc-os-ui', requireSecrets().passwords['svc-os-ui']], user: viewer, source: 'os-ui/parity/query' }));

before(async () => {
  if (skip) return;
  requireSecrets();
  for (const [fqn, meta] of Object.entries(tables)) opaPut(`governance/tables/${encodeURIComponent(fqn)}`, meta);
  for (const [id, p] of Object.entries(principals)) opaPut(`governance/principals/${encodeURIComponent(id)}`, p);
  if (closed) return; // phase 2 reads the tables phase 1 wrote
  // Setup as an ungoverned harness user over the dual-run HTTP port (the chart's bootstrap file
  // ACL owns every non-personal schema for it; the personal lane is written by its owner).
  const setup = (sql, user = 'lh-setup') => run(sql, { user, source: 'lh-setup' });
  await setup(`CREATE SCHEMA IF NOT EXISTS iceberg.${S}`);
  await setup(`CREATE OR REPLACE TABLE iceberg.${S}.orders AS SELECT * FROM (VALUES (1, 'north', 'a@n.example'), (2, 'south', 'b@s.example'), (3, 'east', NULL)) AS t(id, region, email)`);
  await setup(`CREATE OR REPLACE TABLE iceberg.${S}.kpis AS SELECT * FROM (VALUES ('margin', 0.31), ('revenue', 1200.5)) AS t(k, v)`);
  await setup(`CREATE OR REPLACE TABLE iceberg.${S}.ref AS SELECT * FROM (VALUES (10), (20)) AS t(x)`);
  await setup(`CREATE SCHEMA IF NOT EXISTS iceberg.${LANE}`, ALICE);
  await setup(`CREATE OR REPLACE TABLE iceberg.${LANE}.notes AS SELECT * FROM (VALUES ('n1'), ('n2')) AS t(n)`, ALICE);
});

test('the governance under test is not vacuous (expected rows per viewer)', { skip }, async () => {
  const get = closed ? viaTls : legacy;
  assert.deepEqual((await get(QUERIES.orders, ALICE)).rows, [[1, 'north', 'a@n.example'], [2, 'south', 'b@s.example'], [3, 'east', null]]);
  assert.deepEqual((await get(QUERIES.orders, CAROL)).rows, [[1, 'north', null], [2, 'south', null], [3, 'east', null]], 'pii masked without the clearance');
  assert.deepEqual((await get(QUERIES.orders, BOB)).rows, [], 'cross-domain row filter');
  assert.deepEqual((await get(QUERIES.shared, BOB)).rows.length, 2, 'shared with D2');
  assert.deepEqual((await get(QUERIES.lane, ALICE)).rows, [['n1'], ['n2']], 'owner reads the lane');
  assert.equal((await get(QUERIES.lane, CAROL)).error, 'PERMISSION_DENIED', 'nobody else reads the lane');
});

test('every viewer gets byte-identical answers on the legacy and the TLS path', { skip }, async () => {
  let baseline;
  if (closed) {
    assert.ok(existsSync(baselineFile()), 'phase 1 (dual-run) must run first and store the legacy answers');
    baseline = JSON.parse(readFileSync(baselineFile(), 'utf8'));
  } else {
    baseline = {};
    for (const v of VIEWERS) for (const [name, sql] of Object.entries(QUERIES)) baseline[`${v} ${name}`] = await legacy(sql, v);
    writeFileSync(baselineFile(), JSON.stringify(baseline, null, 2));
  }
  const now = {};
  for (const v of VIEWERS) for (const [name, sql] of Object.entries(QUERIES)) now[`${v} ${name}`] = await viaTls(sql, v);
  assert.deepEqual(now, baseline);
  assert.equal(Object.keys(now).length, VIEWERS.length * Object.keys(QUERIES).length);
});

test('resource groups (#175) select the same group on the TLS path: global.domains.<d>.<session user>', { skip }, async () => {
  const ui = ['svc-os-ui', requireSecrets().passwords['svc-os-ui']];
  const ids = {};
  for (const v of [ALICE, D1]) ids[v] = (await runTls('SELECT 1', { auth: ui, user: v, source: 'os-ui/parity/query' })).id;
  const list = Object.values(ids).map((i) => `'${i}'`).join(',');
  const { rows } = await runTls(`SELECT query_id, "user", resource_group_id FROM system.runtime.queries WHERE query_id IN (${list})`, { auth: ui, source: 'lh-observer' });
  const got = Object.fromEntries(rows.map(([id, user, rg]) => [id, { user, rg: rg.join('.') }]));
  for (const [v, id] of Object.entries(ids)) assert.deepEqual(got[id], { user: v, rg: `global.domains.parity.${v}` }, v);
});
