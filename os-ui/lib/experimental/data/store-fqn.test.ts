/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSchema, assetTarget, versionTarget, personalSchema, readPrincipalFor, physicalSlug, bronzeTarget } from './store-fqn.ts';
import { goldJoinPlan } from './transform.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';

// A HYPHENATED domain (the live cohort `agentic-leader-q3-2026`) must never reach Trino
// as a raw identifier — it is a SYNTAX_ERROR. domainSchema normalizes it to a valid one.
test('domainSchema normalizes a hyphenated domain to a legal Trino identifier', () => {
  assert.equal(domainSchema('agentic-leader-q3-2026'), 'agentic_leader_q3_2026');
  assert.equal(domainSchema('sales'), 'sales'); // already legal → unchanged (no regression)
});

function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_x', name: 'Campaign Data', owner: 'aborek',
    domain: 'agentic-leader-q3-2026', tier: 'asset', visibility: 'domain',
    description: 'x', versions, grants: [], measures: [],
    columns: [{ name: 'id', description: 'k' }], ...over,
  };
}

test('governed FQNs for a hyphenated domain contain NO raw hyphen', () => {
  const target = assetTarget(ds());
  // A NON-owner reads the promoted copy from the (sanitized) domain schema.
  const vt = versionTarget(ds(), 'gold', { id: 'other_viewer' });
  assert.equal(target, 'iceberg.agentic_leader_q3_2026.gold_campaign_data');
  assert.doesNotMatch(target, /-/, 'no hyphen may reach Trino');
  assert.equal(vt, 'iceberg.agentic_leader_q3_2026.gold_campaign_data');
  assert.doesNotMatch(vt, /-/, 'no hyphen may reach Trino');
});

// BUG (data-lane isolation): the OWNER's personal lane physically holds EVERY layer
// (bronze + un-promoted silver/gold). An owner reading their own dataset must resolve
// ALL layers to `personal_<owner>` — NOT the domain schema (where only promoted golds
// live → the live `TABLE_NOT_FOUND` on bronze_northpeak_cac_cos_weekly).
test('versionTarget: the OWNER reads every layer from their personal lane', () => {
  const d = ds(); // owner: aborek
  const owner = { id: 'aborek' };
  assert.equal(versionTarget(d, 'bronze', owner), 'iceberg.personal_aborek.bronze_campaign_data');
  assert.equal(versionTarget(d, 'silver', owner), 'iceberg.personal_aborek.silver_campaign_data');
  assert.equal(versionTarget(d, 'gold', owner), 'iceberg.personal_aborek.gold_campaign_data');
});

test('versionTarget: a NON-owner reads a promoted layer from the domain schema', () => {
  const d = ds(); // shared asset in agentic-leader-q3-2026
  const nonOwner = { id: 'someone_else' };
  assert.equal(versionTarget(d, 'gold', nonOwner), 'iceberg.agentic_leader_q3_2026.gold_campaign_data');
  assert.equal(versionTarget(d, 'silver', nonOwner), 'iceberg.agentic_leader_q3_2026.silver_campaign_data');
});

// FAIL-CLOSED: we NEVER construct a `personal_<otherUser>` FQN for a non-owner — a
// non-owner's bronze read resolves to the domain schema (where bronze was never copied,
// so it simply won't find a table), and no other user's private lane is ever named.
test('versionTarget: a NON-owner NEVER gets a personal_<owner> FQN (fail-closed)', () => {
  const d = ds(); // owner: aborek
  const nonOwner = { id: 'someone_else' };
  for (const layer of ['bronze', 'silver', 'gold'] as const) {
    const fqn = versionTarget(d, layer, nonOwner);
    assert.doesNotMatch(fqn, /personal_/, 'no personal lane may be named for a non-owner');
    assert.match(fqn, /^iceberg\.agentic_leader_q3_2026\./);
  }
});

// CONNECTED · LIVE (lakehouse-import-exposure.md, Phase 2): the FQN is the verbatim
// external `catalog.schema.table` — for EVERYONE, at EVERY layer, no personal lane, no
// iceberg prefix. It is NOT the owner's personal table and NOT the domain schema.
function connectedDs(over: Partial<Dataset> = {}): Dataset {
  return ds({
    origin: 'connected',
    connected: {
      connectionId: 'conn_1', exposureId: 'exp_1',
      source: { catalog: 'glue_sales', schema: 'public', table: 'orders' },
      mode: 'live', tier: 'silver', status: 'ok',
    },
    ...over,
  });
}

test('versionTarget: a LIVE connected dataset resolves to the verbatim external FQN', () => {
  const d = connectedDs();
  // Owner and non-owner alike get the exact external table — no personal/domain rewriting.
  assert.equal(versionTarget(d, 'silver', { id: 'aborek' }), 'glue_sales.public.orders');
  assert.equal(versionTarget(d, 'gold', { id: 'someone_else' }), 'glue_sales.public.orders');
  assert.doesNotMatch(versionTarget(d, 'silver', { id: 'aborek' }), /iceberg\.|personal_/);
});

test('personalSchema stays owner-keyed + sanitized', () => {
  assert.equal(personalSchema('aborek'), 'personal_aborek');
  assert.equal(personalSchema('a.b@x.com'), 'personal_a_b_x_com');
});

// BUG 1: reading the caller's OWN personal table must run AS the owner (user.id), not
// the domain principal — a `personal_<uid>` schema is owner-only under Trino OPA.
test('readPrincipalFor: a read of the caller OWN personal lane runs as the owner id', () => {
  const aborek = { id: 'aborek', domains: ['agentic-leader-q3-2026'] };
  // The exact live query that hit PERMISSION_DENIED under the domain principal.
  const sql = 'select name from iceberg.personal_aborek.bronze_agentic_leader_q3_2026_participants limit 10';
  assert.equal(readPrincipalFor(sql, aborek), 'aborek');
});

test('readPrincipalFor: a governed/domain read runs as the caller domain principal', () => {
  const aborek = { id: 'aborek', domains: ['agentic-leader-q3-2026'] };
  const sql = 'select region, sum(revenue) from iceberg.agentic_leader_q3_2026.gold_orders group by region';
  assert.equal(readPrincipalFor(sql, aborek), 'agentic-leader-q3-2026');
  // No qualified table at all (e.g. `select 1`) → domain principal, not impersonation.
  assert.equal(readPrincipalFor('select 1', aborek), 'agentic-leader-q3-2026');
});

test('readPrincipalFor: ANOTHER user personal schema is NOT impersonated (stays on domain)', () => {
  const aborek = { id: 'aborek', domains: ['sales'] };
  // A reference to someone else's personal lane must never flip us to their identity —
  // OPA denies it regardless; we never mint the owner principal for a lane we don't own.
  const sql = 'select * from iceberg.personal_someoneelse.bronze_secret limit 10';
  assert.equal(readPrincipalFor(sql, aborek), 'sales');
});

test('readPrincipalFor: with no domains, falls back to the caller id', () => {
  assert.equal(readPrincipalFor('select 1', { id: 'solo', domains: [] }), 'solo');
});

// CURATED CONVERGENCE (the "Suggest Quality Rules finds nothing for curated" root cause):
// a curated dataset has NO bronze/silver — its Gold is composed straight into the OWNER's
// personal lane by `goldJoinPlan` (target = iceberg.personal_<owner>.gold_<slug>). The
// profile/preview/dq resolver reads the OWNER's built Gold via `versionTarget`. If those two
// FQNs ever diverged, `describe`/stats would hit a non-existent table → an EMPTY (but silent)
// suggestion list. This pins the invariant: the resolver targets EXACTLY what the build wrote.
test('curated Gold: builtLayerFqn resolver (versionTarget) == the FQN goldJoinPlan writes', () => {
  const curated = ds({ name: 'Curated Service Data', tier: 'dataset', visibility: 'private', slug: undefined });
  const owner = { id: 'aborek', domains: ['agentic-leader-q3-2026'] };

  // What the curated build path physically CTAS-es (base overrides ref 0; own-silver unused).
  const plan = goldJoinPlan(
    { name: curated.name, domain: curated.domain, tier: curated.tier, slug: curated.slug },
    { uid: owner.id, domains: owner.domains },
    [], // no joins — a curated single-base projection (ref 0 = the resolved base)
    [{ col: { ref: 0, column: 'partner_name' } }], // one dimension off the base
    [],
    [],
    'iceberg.agentic_leader_q3_2026.gold_northpeak_logistics_partners', // resolved base
  );

  // What the profile/dq resolver reads as (the OWNER, furthest built = gold).
  const resolved = versionTarget(curated, 'gold', { id: owner.id });

  assert.equal(plan.target, 'iceberg.personal_aborek.gold_curated_service_data');
  assert.equal(resolved, plan.target, 'the dq/profile resolver must target the exact table the curated build wrote');
});

// ---------------------------------------------- FROZEN slug — physical-identity stability --

// A dataset with NO frozen slug resolves to slug(name) — the byte-stable legacy behaviour.
test('physicalSlug: absent slug falls back to slug(name) (byte-stable, zero migration)', () => {
  assert.equal(physicalSlug({ name: 'Campaign Data' }), 'campaign_data');
  assert.equal(physicalSlug({ name: 'Northpeak CAC/COS Weekly' }), 'northpeak_cac_cos_weekly');
});

// Once a rename FREEZES the slug, the physical identity is pinned to it — NOT the name.
test('physicalSlug: a frozen slug pins the identity regardless of the display name', () => {
  assert.equal(physicalSlug({ slug: 'campaign_data', name: 'Totally Renamed' }), 'campaign_data');
});

// FQN STABILITY: create "Foo" → its FQNs use slug("Foo"); a rename to "Bar" that FREEZES
// the slug to `foo` keeps every FQN + Cube/dbt identity on `foo`, never `bar`.
test('FQN stability: a renamed dataset keeps its ORIGINAL physical FQNs (frozen slug)', () => {
  const foo = ds({ name: 'Foo', slug: undefined });
  const owner = { id: 'aborek' };
  // Before rename: derived from slug("Foo") === "foo".
  assert.equal(versionTarget(foo, 'gold', owner), 'iceberg.personal_aborek.gold_foo');
  assert.equal(assetTarget(foo), 'iceberg.agentic_leader_q3_2026.gold_foo');

  // Rename to "Bar" pins slug=foo (what renameDataset does). The FQNs must NOT move to bar.
  const renamed = ds({ name: 'Bar', slug: 'foo' });
  assert.equal(versionTarget(renamed, 'gold', owner), 'iceberg.personal_aborek.gold_foo');
  assert.equal(versionTarget(renamed, 'bronze', owner), 'iceberg.personal_aborek.bronze_foo');
  assert.equal(assetTarget(renamed), 'iceberg.agentic_leader_q3_2026.gold_foo');
  assert.equal(bronzeTarget(personalSchema('aborek'), physicalSlug(renamed)), 'iceberg.personal_aborek.bronze_foo');
  // Sanity: the NEW name's slug would have been "bar" — proving the freeze prevented the move.
  assert.doesNotMatch(assetTarget(renamed), /_bar/, 'a rename must NEVER move the physical table');
});
