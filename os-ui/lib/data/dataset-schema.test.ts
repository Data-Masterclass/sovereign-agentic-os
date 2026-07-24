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

test('hard storage line: datasets -> personal Iceberg lane; assets/products -> shared Trino', () => {
  assert.equal(storageFor('dataset'), 'personal-iceberg');
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

test('folder defaults to root and is normalised on parse', () => {
  // Absent → root (old datasets parse unchanged at root).
  assert.equal(parseDataset({ name: 'X', owner: 'a', domain: 'sales' }).folder, '/');
  // Any spelling normalises to a single leading slash, no trailing slash.
  assert.equal(parseDataset({ name: 'X', owner: 'a', domain: 'sales', folder: 'contracts/' }).folder, '/contracts');
  assert.equal(parseDataset({ name: 'X', owner: 'a', domain: 'sales', folder: '/a/b' }).folder, '/a/b');
});

test('folder is byte-stable: omitted at root, round-trips off-root', () => {
  // A root dataset serializes EXACTLY as before — no `folder:` key appears, so no old
  // record churns (the omit-when-root precedent).
  const rootYaml = serializeDataset(sample({ folder: '/' }));
  assert.equal(rootYaml, serializeDataset(sample()));
  assert.ok(!/(^|\n)folder:/.test(rootYaml), 'root dataset must not emit a folder key');
  // An off-root folder is emitted and survives a round-trip.
  const moved = sample({ folder: '/contracts' });
  const yaml = serializeDataset(moved);
  assert.match(yaml, /(^|\n)folder: \/contracts/);
  assert.equal(parseDataset(yaml).folder, '/contracts');
});

test('bad shape throws a DatasetError (store never holds garbage)', () => {
  assert.throws(() => parseDataset({ tier: 'nonsense' }), DatasetError);
  assert.throws(() => parseDataset({ grants: [{ grantee: { kind: 'bogus', id: 'x' } }] }), DatasetError);
});

// ---------------------------------------- FROZEN slug: byte-stability + round-trip --

// Byte-stability: a dataset that has NEVER been renamed carries no `slug` field, so its
// serialized yaml is byte-identical to before the feature existed (no live record churns).
test('byte-stability: a dataset with no frozen slug omits the slug key entirely', () => {
  const yaml = serializeDataset(sample({ name: 'Orders' }));
  assert.doesNotMatch(yaml, /(^|\n)slug:/, 'slug must be omitted while still derivable');
});

// Even a slug that EQUALS slug(name) is omitted (still derivable) — no churn.
test('byte-stability: a slug equal to slug(name) is still omitted (derivable)', () => {
  const yaml = serializeDataset(sample({ name: 'Orders', slug: 'orders' }));
  assert.doesNotMatch(yaml, /(^|\n)slug:/, 'a derivable slug is never written');
});

// A DECOUPLED slug (a rename happened: slug !== slug(name)) IS written + round-trips.
test('round-trip: a decoupled (renamed) slug is written and parses back', () => {
  const d = sample({ name: 'Sales Orders', slug: 'orders' }); // decoupled: slug("Sales Orders")="sales_orders"
  const yaml = serializeDataset(d);
  assert.match(yaml, /(^|\n)slug: orders(\n|$)/, 'a decoupled slug must be persisted');
  const parsed = parseDataset(yaml);
  assert.equal(parsed.slug, 'orders');
  assert.equal(parsed.name, 'Sales Orders');
});

// A legacy record with no slug parses with slug === undefined (byte-stable, zero migration).
test('round-trip: a legacy record with no slug parses to undefined slug', () => {
  const yaml = serializeDataset(sample({ name: 'Orders' }));
  assert.equal(parseDataset(yaml).slug, undefined);
});
