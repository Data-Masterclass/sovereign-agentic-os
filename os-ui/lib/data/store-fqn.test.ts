/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSchema, assetTarget, versionTarget, personalSchema } from './store-fqn.ts';
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
  const vt = versionTarget(ds(), 'gold');
  assert.equal(target, 'iceberg.agentic_leader_q3_2026.gold_campaign_data');
  assert.doesNotMatch(target, /-/, 'no hyphen may reach Trino');
  assert.equal(vt, 'iceberg.agentic_leader_q3_2026.gold_campaign_data');
});

test('personalSchema stays owner-keyed + sanitized', () => {
  assert.equal(personalSchema('aborek'), 'personal_aborek');
  assert.equal(personalSchema('a.b@x.com'), 'personal_a_b_x_com');
});
