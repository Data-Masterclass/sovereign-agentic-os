/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineageFor } from './lineage.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';

function ds(over: Partial<Dataset> = {}): Dataset {
  const v = emptyVersions();
  v.bronze.built = true; v.silver.built = true; v.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'product', visibility: 'shared', description: 'Orders.', versions: v,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [{ name: 'order_id', description: 'k' }, { name: 'net_amount', description: 'v' }],
    certification: { level: 'gold', by: 'sara', at: '2026-06-30' },
    ...over,
  };
}

test('lineage chains bronze→silver→gold (refinement, column-level)', () => {
  const g = lineageFor(ds());
  const versionIds = g.nodes.filter((n) => n.kind === 'version').map((n) => n.id);
  assert.deepEqual(versionIds, ['v:bronze', 'v:silver', 'v:gold']);
  assert.deepEqual(
    g.edges.filter((e) => e.kind === 'refinement'),
    [{ from: 'v:bronze', to: 'v:silver', kind: 'refinement' }, { from: 'v:silver', to: 'v:gold', kind: 'refinement' }],
  );
  assert.deepEqual(g.nodes.find((n) => n.id === 'v:gold')!.columns, ['order_id', 'net_amount']);
});

test('consumption axis: gold → metric → dashboard', () => {
  const g = lineageFor(ds());
  assert.ok(g.edges.some((e) => e.from === 'v:gold' && e.to === 'm:revenue' && e.kind === 'metric'));
  assert.ok(g.edges.some((e) => e.from === 'm:revenue' && e.to === 'dash' && e.kind === 'dashboard'));
});

test('reuse axis: recorded join upstreams feed the Gold node (multi-upstream)', () => {
  const g = lineageFor(ds({
    upstreams: [
      { datasetId: 'ds_np', name: 'Northpeak Commerce', fqn: 'iceberg.sales.gold_northpeak_commerce', joinType: 'inner' },
      { datasetId: 'ds_cmp', name: 'Campaigns', fqn: 'iceberg.sales.gold_campaigns', joinType: 'left' },
    ],
  }));
  const ups = g.nodes.filter((n) => n.kind === 'upstream');
  assert.deepEqual(ups.map((n) => n.label), ['Northpeak Commerce', 'Campaigns']);
  assert.equal(g.edges.filter((e) => e.kind === 'join' && e.to === 'v:gold').length, 2);
  assert.match(ups[0].sublabel, /inner join · iceberg\.sales\.gold_northpeak_commerce/);
});

test('no upstream nodes when there is no Gold join (backwards compatible)', () => {
  assert.equal(lineageFor(ds()).nodes.filter((n) => n.kind === 'upstream').length, 0);
});

test('trust axis + transparency are carried on the graph', () => {
  const g = lineageFor(ds());
  assert.equal(g.tier, 'product');
  assert.equal(g.certification?.level, 'gold');
  assert.equal(g.transparency.ok, true);
});

test('an undocumented dataset surfaces a red transparency gate', () => {
  const g = lineageFor(ds({ description: '', columns: [] }));
  assert.equal(g.transparency.ok, false);
  assert.ok(g.transparency.missing.includes('description'));
});

test('only built layers appear; a bronze-only dataset has no metric chain', () => {
  const v = emptyVersions(); v.bronze.built = true;
  const g = lineageFor(ds({ versions: v, measures: [] }));
  assert.deepEqual(g.nodes.map((n) => n.id), ['v:bronze']);
  assert.equal(g.edges.length, 0);
});
