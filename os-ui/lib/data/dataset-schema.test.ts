/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataset,
  serializeDataset,
  storageFor,
  canTransition,
  tierAfter,
  visibilityFor,
  emptyVersions,
  DatasetError,
  type Dataset,
} from './dataset-schema.ts';

function sample(over: Partial<Dataset> = {}): Dataset {
  return {
    version: '1',
    id: 'ds_orders',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'dataset',
    visibility: 'private',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
    ...over,
  };
}

test('hard storage line: datasets -> DuckDB; assets/products -> Trino', () => {
  assert.equal(storageFor('dataset'), 'duckdb-sandbox');
  assert.equal(storageFor('asset'), 'trino-iceberg');
  assert.equal(storageFor('product'), 'trino-iceberg');
});

test('role gates: Creator cannot promote; Builder promotes; only Admin certifies', () => {
  // participant === Creator persona
  assert.equal(canTransition('creator', 'dataset', 'promote').ok, false);
  assert.equal(canTransition('builder', 'dataset', 'promote').ok, true);
  assert.equal(canTransition('admin', 'dataset', 'promote').ok, true);

  assert.equal(canTransition('builder', 'asset', 'certify').ok, false);
  assert.equal(canTransition('admin', 'asset', 'certify').ok, true);
});

test('transitions must be legal single steps on the lifecycle line', () => {
  // cannot certify straight from a dataset
  assert.equal(canTransition('admin', 'dataset', 'certify').ok, false);
  // reverse moves are gated like the forward move they undo
  assert.equal(canTransition('creator', 'asset', 'unshare').ok, false);
  assert.equal(canTransition('builder', 'asset', 'unshare').ok, true);
  assert.equal(canTransition('builder', 'product', 'decertify').ok, false);
  assert.equal(canTransition('admin', 'product', 'decertify').ok, true);
});

test('tierAfter walks the lifecycle both ways', () => {
  assert.equal(tierAfter('dataset', 'promote'), 'asset');
  assert.equal(tierAfter('asset', 'certify'), 'product');
  assert.equal(tierAfter('asset', 'unshare'), 'dataset');
  assert.equal(tierAfter('product', 'decertify'), 'asset');
});

test('visibility is clamped to the tier (a dataset is always private)', () => {
  assert.equal(visibilityFor('dataset', 'public'), 'private');
  assert.equal(visibilityFor('asset', 'public'), 'shared'); // assets max out at shared
  assert.equal(visibilityFor('product', 'private'), 'domain'); // products are at least domain-visible
});

test('parse/serialize round-trips and normalises visibility to the tier', () => {
  const d = sample({ tier: 'asset', visibility: 'public', grants: [
    { grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' },
  ] });
  const round = parseDataset(serializeDataset(d));
  assert.equal(round.tier, 'asset');
  assert.equal(round.visibility, 'shared'); // public clamped to shared for an asset
  assert.equal(round.grants.length, 1);
  assert.equal(round.grants[0].grantee.id, 'sales');
});

test('grant cardinality is tagged at the source (R1) and defaults to low', () => {
  const d = parseDataset({
    name: 'X', owner: 'a', domain: 'sales', tier: 'asset',
    grants: [{ grantee: { kind: 'user', id: 'kenji' }, scope: { rows: ['region = $region'] } }],
  });
  assert.equal(d.grants[0].cardinality, 'low');
  assert.deepEqual(d.grants[0].scope.rows, ['region = $region']);
});

test('bad shape throws a DatasetError (store never holds garbage)', () => {
  assert.throws(() => parseDataset({ tier: 'nonsense' }), DatasetError);
  assert.throws(() => parseDataset({ grants: [{ grantee: { kind: 'bogus', id: 'x' } }] }), DatasetError);
});
