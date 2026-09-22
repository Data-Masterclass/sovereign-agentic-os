/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCubeModels, cubeDeliverable, cubeModelYaml } from './cube-models.ts';
import { compileCube } from './policy/compiler.ts';
import { emptyVersions, type Dataset, type Grant } from './dataset-schema.ts';

function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

const maskGrant = (col: string): Grant => ({
  grantee: { kind: 'domain', id: 'sales' },
  scope: { rows: [], columns: { mask: [col], hide: [] } },
  cardinality: 'low',
  action: 'read',
});

test('payload shape: one entry per shared dataset with view + measures + access', () => {
  const { models } = buildCubeModels([ds()]);
  assert.equal(models.length, 1);
  const m = models[0];
  assert.equal(m.name, 'orders');
  assert.equal(m.view, 'Orders');
  assert.equal(m.file, 'metrics/orders.cube.yml');
  assert.deepEqual(m.measures, ['revenue']);
  // The access policy rides alongside the model (same compiler as Trino OPA).
  assert.equal(m.access.cube, 'orders');
  assert.deepEqual(m.access.allowDomains, ['sales']);
  assert.equal(m.access.public, false);
  assert.match(m.model, /sql_table: iceberg\.sales\.gold_orders/);
});

test('same-name duplicate datasets collapse to ONE entry per cube file (the richest)', () => {
  // Two datasets with the same name map to the SAME cube file — a duplicate would make
  // the sidecar overwrite one with the other every poll (a measure vanishes). The payload
  // must keep a single entry per file, preferring the one with more measures.
  const a = ds({ id: 'ds_a', measures: [{ name: 'contribution_margin', type: 'sum', sql: 'net_amount' }] });
  const b = ds({ id: 'ds_b', measures: [
    { name: 'contribution_margin', type: 'sum', sql: 'net_amount' },
    { name: 'total_contribution_in', type: 'sum', sql: 'net_amount' },
  ] });
  const { models } = buildCubeModels([a, b]);
  const forFile = models.filter((m) => m.file === 'metrics/orders.cube.yml');
  assert.equal(forFile.length, 1); // collapsed, not two colliding entries
  assert.ok(forFile[0].measures.includes('total_contribution_in')); // kept the richer one
});

test('#155 two domains, SAME name, namespaced → TWO distinct model files (no last-writer-wins)', () => {
  // The core bug: pre-#155 both would map to `metrics/sales.cube.yml` and the sidecar
  // would overwrite one with the other. Namespaced, they land on separate files, so BOTH
  // survive and the access policy joins for each (no dropped entry).
  const sales = ds({ id: 'ds_s', domain: 'sales', name: 'Sales', cubeNamespaced: true });
  const finance = ds({ id: 'ds_f', owner: 'kenji', domain: 'finance', name: 'Sales', cubeNamespaced: true });
  const { models } = buildCubeModels([sales, finance]);
  assert.equal(models.length, 2); // both delivered — neither clobbers the other
  const files = models.map((m) => m.file).sort();
  assert.deepEqual(files, ['metrics/finance__sales.cube.yml', 'metrics/sales__sales.cube.yml']);
  // Each entry's access policy resolved (the compiler key matched the model name).
  for (const m of models) assert.equal(m.access.cube, m.name);
  assert.match(models.find((m) => m.name === 'sales__sales')!.model, /sql_table: iceberg\.sales\.gold_sales/);
  assert.match(models.find((m) => m.name === 'finance__sales')!.model, /sql_table: iceberg\.finance\.gold_sales/);
});

test('#155 a legacy (un-namespaced) dataset keeps its exact old file + name (live untouched)', () => {
  const legacy = ds({ domain: 'sales', name: 'Orders' }); // no marker
  const { models } = buildCubeModels([legacy]);
  assert.equal(models[0].name, 'orders');
  assert.equal(models[0].file, 'metrics/orders.cube.yml');
  assert.equal(models[0].access.cube, 'orders'); // join still resolves for legacy
});

test('a non-shared (private) dataset is EXCLUDED', () => {
  const priv = ds({ id: 'ds_p', name: 'Scratch', tier: 'dataset', visibility: 'private' });
  const { models } = buildCubeModels([ds(), priv]);
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'orders');
  assert.equal(cubeDeliverable(priv), false);
});

test('a governed dataset with NO built Gold is excluded (no mart to bind to)', () => {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true; // gold NOT built
  const noGold = ds({ id: 'ds_ng', name: 'Half', versions });
  assert.equal(cubeDeliverable(noGold), false);
  assert.equal(buildCubeModels([noGold]).models.length, 0);
});

test('measures fall back to count when none are defined (matches the YAML)', () => {
  const { models } = buildCubeModels([ds({ measures: [] })]);
  assert.deepEqual(models[0].measures, ['count']);
});

test('embed on: restricted columns become a member_level excludes block', () => {
  const withMask = ds({ grants: [maskGrant('net_amount')] });
  const [policy] = compileCube([withMask]);
  assert.deepEqual(policy.excludes, ['net_amount']);
  const { models } = buildCubeModels([withMask], { embedAccessPolicy: true });
  assert.match(models[0].model, /access_policy:/);
  assert.match(models[0].model, /excludes: \[net_amount\]/);
  // The access_policy sits inside the cube, before the views section.
  assert.ok(models[0].model.indexOf('access_policy') < models[0].model.indexOf('\nviews:'));
});

test('embed off: no access_policy block, but the policy still rides in the payload', () => {
  const withMask = ds({ grants: [maskGrant('net_amount')] });
  const { models } = buildCubeModels([withMask], { embedAccessPolicy: false });
  assert.doesNotMatch(models[0].model, /access_policy/);
  assert.deepEqual(models[0].access.excludes, ['net_amount']);
});

test('no excludes: model is the plain scaffold even with embed on', () => {
  const { models } = buildCubeModels([ds()], { embedAccessPolicy: true });
  assert.doesNotMatch(models[0].model, /access_policy/);
});

test('cubeModelYaml keeps valid structure — cube, measures, dimensions, view all present', () => {
  const withMask = ds({ grants: [maskGrant('region')] });
  const [policy] = compileCube([withMask]);
  const yaml = cubeModelYaml(withMask, policy, true);
  assert.match(yaml, /cubes:/);
  assert.match(yaml, /measures:/);
  assert.match(yaml, /dimensions:/);
  assert.match(yaml, /views:/);
  assert.match(yaml, /access_policy:/);
});

test('models are sorted by cube name and generatedAt is stamped', () => {
  const zed = ds({ id: 'z', name: 'Zeta' });
  const alp = ds({ id: 'a', name: 'Alpha' });
  const { models, generatedAt } = buildCubeModels([zed, alp], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(models.map((m) => m.name), ['alpha', 'zeta']);
  assert.equal(generatedAt, '2026-01-01T00:00:00.000Z');
});
