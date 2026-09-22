/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transparencyGate, hasUpstreamEdge, gateReason } from './transparency.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';

function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true; // bronze→silver = an upstream edge
  return {
    version: '1', id: 'ds_x', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'dataset', visibility: 'private',
    description: 'Sales orders.', versions,
    grants: [], measures: [],
    columns: [{ name: 'order_id', description: 'Surrogate key.' }],
    ...over,
  };
}

test('a fully documented dataset passes the gate', () => {
  const r = transparencyGate(ds());
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.match(gateReason(r), /green/);
});

test('documentation is advisory — missing description/column docs no longer block', () => {
  // Relaxed gate: a description, per-column descriptions and an upstream edge are
  // ENCOURAGED but do NOT hard-block promotion (they were stopping cohort work with no
  // security value). Only the structural essentials (owner/domain/tier) still gate.
  assert.equal(transparencyGate(ds({ description: '   ' })).ok, true);
  assert.equal(transparencyGate(ds({ columns: [{ name: 'x', description: '' }] })).ok, true);
});

test('an upstream edge requires ≥2 built layers or a metric', () => {
  const oneLayer = emptyVersions();
  oneLayer.bronze.built = true;
  assert.equal(hasUpstreamEdge(ds({ versions: oneLayer })), false);
  // a metric defined downstream also counts as lineage
  assert.equal(hasUpstreamEdge(ds({ versions: oneLayer, measures: [{ name: 'rev', type: 'sum', sql: 'net_amount' }] })), true);
});

test('the gate names only the STRUCTURAL gaps (owner/domain/tier)', () => {
  const bare = emptyVersions();
  // domain/tier/visibility are set on ds(); only owner is blank → the sole hard gap.
  const r = transparencyGate(ds({ owner: '', description: '', columns: [], versions: bare }));
  assert.deepEqual(r.missing.sort(), ['owner']);
});
