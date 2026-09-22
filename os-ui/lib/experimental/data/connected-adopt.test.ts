/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Adopt flow + FQN seam + revocation propagation for LIVE connected datasets
 * (lakehouse-import-exposure.md, Phase 2). Store-level, offline: the mirror is a
 * graceful no-op so the in-process registry is authoritative.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  adoptConnectedDataset,
  builtLayerFqn,
  getDataset,
  markDatasetsSourceRevoked,
  markDatasetsDrifted,
  type Principal,
} from './store.ts';
import { DatasetError } from './dataset-schema.ts';

const dadmin: Principal = { id: 'dana', domains: ['commerce'], role: 'domain_admin' };
const viewer: Principal = { id: 'vic', domains: ['commerce'], role: 'creator' };

beforeEach(() => __resetStore());

function adopt(over: Partial<Parameters<typeof adoptConnectedDataset>[1]> = {}) {
  return adoptConnectedDataset(dadmin, {
    name: 'Orders (live)',
    domain: 'commerce',
    description: 'Live orders from the Databricks connection.',
    connected: {
      connectionId: 'conn_1',
      exposureId: 'exp_1',
      source: { catalog: 'glue_sales', schema: 'public', table: 'orders' },
      mode: 'live',
      tier: 'silver',
      status: 'ok',
    },
    ...over,
  });
}

test('adoptConnectedDataset: born at DOMAIN tier, origin connected, only the tier layer built', () => {
  const d = adopt();
  assert.equal(d.tier, 'asset');
  assert.equal(d.visibility, 'domain');
  assert.equal(d.origin, 'connected');
  assert.equal(d.connected?.mode, 'live');
  assert.equal(d.versions.silver.built, true);
  assert.equal(d.versions.bronze.built, false, 'bronze never exists for a live connected dataset');
  assert.equal(d.versions.gold.built, false);
  assert.equal(d.description, 'Live orders from the Databricks connection.');
});

test('adoptConnectedDataset: a required description is enforced', () => {
  assert.throws(() => adopt({ description: '   ' }), (e: unknown) => {
    assert.ok(e instanceof DatasetError);
    assert.equal((e as DatasetError).status, 400);
    return true;
  });
});

test('adoptConnectedDataset: a gold-tier exposure builds only the gold layer', () => {
  const d = adopt({ connected: { connectionId: 'c', exposureId: 'e', source: { catalog: 'g', schema: 's', table: 't' }, mode: 'live', tier: 'gold', status: 'ok' } });
  assert.equal(d.versions.gold.built, true);
  assert.equal(d.versions.silver.built, false);
});

test('builtLayerFqn: a live connected dataset resolves to the external FQN + DOMAIN principal', () => {
  const d = adopt();
  // A viewer who is NOT the owner still reads the external table AS their domain principal.
  const resolved = builtLayerFqn(getDataset(d.id, viewer), viewer);
  assert.ok(resolved);
  assert.equal(resolved!.fqn, 'glue_sales.public.orders');
  assert.equal(resolved!.layer, 'silver');
  assert.equal(resolved!.principal, 'commerce', 'reads AS the viewer domain principal, never a personal lane');
});

test('builtLayerFqn: a source-revoked live dataset resolves to NO table (calm not-materialized)', () => {
  const d = adopt();
  markDatasetsSourceRevoked('exp_1');
  const resolved = builtLayerFqn(getDataset(d.id, viewer), viewer);
  assert.equal(resolved, null);
});

test('markDatasetsSourceRevoked: flips bound datasets to source-revoked, idempotently', () => {
  const d = adopt();
  const first = markDatasetsSourceRevoked('exp_1');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, d.id);
  assert.equal(getDataset(d.id, dadmin).connected?.status, 'source-revoked');
  // A second revoke does not re-report an already-frozen dataset (no re-notify).
  assert.equal(markDatasetsSourceRevoked('exp_1').length, 0);
});

test('markDatasetsSourceRevoked: leaves datasets bound to OTHER exposures untouched', () => {
  adopt();
  const other = markDatasetsSourceRevoked('exp_999');
  assert.equal(other.length, 0);
});

test('markDatasetsDrifted: flags a bound live dataset when its table was removed from the snapshot', () => {
  const d = adopt();
  const drifted = markDatasetsDrifted('conn_1', [{ schema: 'public', table: 'orders' }]);
  assert.equal(drifted.length, 1);
  assert.equal(getDataset(d.id, dadmin).connected?.status, 'drifted');
  // Drift never overrides a revoked source (the stronger state).
  markDatasetsSourceRevoked('exp_1');
  markDatasetsDrifted('conn_1', [{ schema: 'public', table: 'orders' }]);
  assert.equal(getDataset(d.id, dadmin).connected?.status, 'source-revoked');
});
