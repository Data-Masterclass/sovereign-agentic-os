/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Real-Trino proof that two same-named datasets never share a personal-lane table,
 *             and that a governed dataset is read from its domain copy by its owner too
 * USER STORY: As a data owner with a draft and a domain asset of the same name I want each to
 *             keep its own tables, so that rebuilding the draft never changes what the asset serves.
 * ARCHITECTURE:
 *   - Runs on the lakehouse harness (tests/lakehouse: the chart's Trino + OPA) through its own
 *     client (lib.mjs). Every statement is the one os-ui compiles (passThroughPlan, publishPlan);
 *     the FQNs come from the store and the resolvers, never from this file.
 *   - Uses only APIs that exist before the fix, so on main the same steps run and the
 *     assertions fail (the negative twin): the two drafts write ONE table.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, transition, getDataset, builtLayerFqn, type Principal } from '@tabs/data/lib/store';
import { versionTarget } from '@tabs/data/lib/store-fqn';
import { passThroughPlan, publishPlan } from '@tabs/data/lib/transform';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../../../../tests/lakehouse/lib.mjs';

const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';
const trino = (sql: string, user: string): Promise<{ rows: unknown[][] }> => run(sql, { user, source: 'os-ui-it' });

const sfx = Date.now().toString(36);
const OWNER = `it_lane_${sfx}`;
const DOM_A = `it-dom-a-${sfx}`;
const DOM_B = `it-dom-b-${sfx}`;
const owner: Principal = { id: OWNER, domains: [DOM_A, DOM_B], role: 'creator' };
const admin: Principal = { id: `it_admin_${sfx}`, domains: [DOM_A, DOM_B], role: 'admin' };
const identity = { uid: OWNER, domains: owner.domains };

beforeEach(() => __resetStore());
before(async () => {
  if (skip) return;
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.personal_${OWNER}`, OWNER);
});

/** Land a Bronze for a dataset at the lane FQN the resolver names, then build Silver and Gold
 *  with the pass-through SQL os-ui compiles — the same statements the build route runs. */
async function buildThroughGold(id: string, marker: string): Promise<void> {
  const d = () => getDataset(id, owner);
  const bronze = versionTarget(d(), 'bronze', owner);
  await trino(`CREATE TABLE ${bronze} AS SELECT * FROM (VALUES ('${marker}', 1), ('${marker}', 2)) AS t(src, n)`, OWNER);
  buildVersion(id, owner, 'bronze', { quality: 'passing', artifact: `bronze/${id}.dlt.yml` });
  await trino(passThroughPlan(d(), identity, 'silver').sql, OWNER);
  buildVersion(id, owner, 'silver', { quality: 'passing', artifact: `silver/${id}.sql`, passThrough: true });
  await trino(passThroughPlan(d(), identity, 'gold').sql, OWNER);
  buildVersion(id, owner, 'gold', { quality: 'passing', artifact: `gold/${id}.sql`, passThrough: true });
}

const markersIn = async (fqn: string, user: string) =>
  [...new Set((await trino(`SELECT src FROM ${fqn}`, user)).rows.map((r) => r[0]))].sort();

test('two same-named datasets of one owner in two domains keep SEPARATE lane tables', { skip }, async () => {
  const a = createDataset(owner, { name: 'Goods Receipts', domain: DOM_A });
  const b = createDataset(owner, { name: 'Goods Receipts', domain: DOM_B });
  await buildThroughGold(a.id, 'A');
  await buildThroughGold(b.id, 'B'); // on main this REPLACES A's lane tables (one shared name)

  const goldA = versionTarget(getDataset(a.id, owner), 'gold', owner);
  const goldB = versionTarget(getDataset(b.id, owner), 'gold', owner);
  assert.notEqual(goldA, goldB, 'one lane table per dataset');
  assert.deepEqual(await markersIn(goldA, OWNER), ['A'], "A's gold still holds A's rows after B was built");
  assert.deepEqual(await markersIn(goldB, OWNER), ['B']);
});

test("a promoted asset is read from its DOMAIN copy by its owner; rebuilding a same-named draft cannot change it", { skip }, async () => {
  const asset = createDataset(owner, { name: 'Receipts', domain: DOM_A });
  await buildThroughGold(asset.id, 'ASSET');
  // Promote: the publish CTAS os-ui compiles copies the owner's lane gold into the domain schema.
  const plan = publishPlan(getDataset(asset.id, owner));
  await trino(plan.schemaSql, OWNER);
  await trino(plan.sql, OWNER);
  transition(asset.id, admin, 'promote', { visibility: 'domain' });

  // A later personal draft of the SAME name in another domain, rebuilt with other data.
  const draft = createDataset(owner, { name: 'Receipts', domain: DOM_B });
  await buildThroughGold(draft.id, 'DRAFT');

  const served = builtLayerFqn(getDataset(asset.id, owner), owner, 'gold');
  assert.ok(served);
  assert.equal(served!.fqn, plan.target, "the owner reads the asset's domain copy, not their lane");
  assert.deepEqual(await markersIn(served!.fqn, OWNER), ['ASSET'], 'the draft rebuild did not reach what the asset serves');
});
