/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSchema, assetTarget, versionTarget, personalSchema, readPrincipalFor } from './store-fqn.ts';
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
