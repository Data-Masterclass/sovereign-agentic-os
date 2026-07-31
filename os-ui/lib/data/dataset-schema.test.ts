/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataset,
  serializeDataset,
  parseGoldSpec,
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

test('origin is byte-stable: omitted unless curated, round-trips when curated', () => {
  // The classic ingest birth serializes EXACTLY as before — no `origin:` key — so no
  // pre-two-path record churns; even an explicit 'ingest' collapses to absent.
  const plain = serializeDataset(sample());
  assert.ok(!/(^|\n)origin:/.test(plain), 'ingest-born dataset must not emit an origin key');
  assert.equal(serializeDataset(sample({ origin: 'ingest' })), plain);
  // A curated birth is written and survives a round-trip.
  const yaml = serializeDataset(sample({ origin: 'curated' }));
  assert.match(yaml, /(^|\n)origin: curated/);
  assert.equal(parseDataset(yaml).origin, 'curated');
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

// ---- Gold spec (stage-4) re-hydration: the raw editable spec is a durable, byte-stable field ----

test('goldSpec round-trips through serialize/parse (the Gold panel re-hydrates from it)', () => {
  const goldSpec = {
    joins: [{ datasetId: 'ds_np', type: 'inner' as const, baseCol: 'order_id', joinCol: 'order_ref', adaptMode: 'cast' as const, adaptType: 'varchar' }],
    dimensions: [{ source: '1::region' }, { source: '0::order_id', as: 'oid' }],
    measures: [{ name: 'net', agg: 'sum', col: '1::net_amount' }, { name: 'n', agg: 'count' }],
  };
  const round = parseDataset(serializeDataset(sample({ goldSpec })));
  assert.deepEqual(round.goldSpec, goldSpec);
});

test('goldSpec is byte-stable: absent when empty, so no prior record churns', () => {
  const bare = serializeDataset(sample());
  assert.equal(serializeDataset(sample({ goldSpec: { joins: [], dimensions: [], measures: [] } })), bare);
  assert.equal(parseDataset(bare).goldSpec, undefined);
});

test('parseGoldSpec sanitizes loose input and drops an all-empty spec', () => {
  assert.equal(parseGoldSpec(undefined), undefined);
  assert.equal(parseGoldSpec({ joins: [], dimensions: [], measures: [] }), undefined);
  const s = parseGoldSpec({
    joins: [{ datasetId: 'ds', type: 'weird', baseCol: 'a', joinCol: 'b' }],
    dimensions: [{ source: '0::x', as: '' }],
    measures: [{ name: 'm', agg: 'sum', col: '0::y' }],
  });
  assert.equal(s?.joins[0].type, 'inner'); // unknown join type coerced to inner
  assert.equal(s?.dimensions[0].as, undefined); // blank alias dropped
  assert.equal(s?.measures[0].col, '0::y');
});

// ------------------------------------------------------- scheduled sync block --

test('sync block: absent stays absent (byte-stable) and round-trips when present', () => {
  const plain = sample();
  assert.ok(!serializeDataset(plain).includes('sync'));
  assert.equal(parseDataset(serializeDataset(plain)).sync, undefined);

  const withSync = sample({
    sync: {
      connectionId: 'conn_pg',
      source: { schema: 'public', table: 'orders' },
      mode: 'append',
      cursor: { kind: 'timestamp', column: 'updated_at' },
      lookbackMinutes: 30,
      schedule: { cron: '0 6 * * *' },
      enabled: true,
    },
  });
  const yamlText = serializeDataset(withSync);
  const back = parseDataset(yamlText);
  assert.deepEqual(back.sync, withSync.sync);
  // Adding then serializing again is stable (no churn).
  assert.equal(serializeDataset(back), yamlText);
});

test('sync block: optional members are omitted from the yaml when unset', () => {
  const d = sample({
    sync: {
      connectionId: 'conn_pg',
      source: { schema: 'public', table: 'orders' },
      mode: 'full-refresh',
      schedule: { cron: '0 6 * * *' },
      enabled: false,
    },
  });
  const y = serializeDataset(d);
  assert.ok(!y.includes('cursor'));
  assert.ok(!y.includes('mergeKeys'));
  assert.ok(!y.includes('lookbackMinutes'));
  assert.deepEqual(parseDataset(y).sync, d.sync);
});

test('sync block: a malformed record parses to undefined (tolerant, never bricks)', () => {
  // Missing connectionId + bad cron -> dropped on parse, dataset still opens.
  const d = parseDataset(
    serializeDataset(sample()).concat('sync:\n  source: { schema: public, table: orders }\n  mode: append\n  schedule: { cron: nonsense }\n  enabled: true\n'),
  );
  assert.equal(d.sync, undefined);
});
