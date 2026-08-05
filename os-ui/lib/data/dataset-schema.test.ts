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

// ----------------------------------------------- connected (Phase 2) back-compat ---

test('back-compat: a legacy dataset.yaml WITHOUT connected loads with no origin/connected', () => {
  const d = parseDataset({ name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset' });
  assert.equal(d.origin, undefined);
  assert.equal(d.connected, undefined);
  // And it serializes without ever emitting a connected key (byte-stable).
  assert.equal(serializeDataset(d).includes('connected'), false);
});

test('connected block round-trips (origin + source + mode/tier/status)', () => {
  const d = sample({
    tier: 'asset',
    visibility: 'domain',
    origin: 'connected',
    connected: {
      connectionId: 'conn_1',
      exposureId: 'exp_1',
      source: { catalog: 'glue_sales', schema: 'public', table: 'orders' },
      mode: 'live',
      tier: 'silver',
      status: 'ok',
    },
  });
  const round = parseDataset(serializeDataset(d));
  assert.equal(round.origin, 'connected');
  assert.deepEqual(round.connected, d.connected);
});

test('a connected origin WITHOUT a valid block downgrades to ingest (no half-connected leak)', () => {
  const round = parseDataset({ name: 'X', owner: 'a', domain: 'sales', tier: 'asset', origin: 'connected' });
  assert.equal(round.origin, undefined);
  assert.equal(round.connected, undefined);
});

test('a stray connected block on a non-connected origin is dropped', () => {
  const round = parseDataset({
    name: 'X', owner: 'a', domain: 'sales', tier: 'asset',
    // origin absent → ingest; the connected block must not survive
    connected: { connectionId: 'c', exposureId: 'e', source: { catalog: 'g', schema: 's', table: 't' }, mode: 'live', tier: 'silver', status: 'ok' },
  });
  assert.equal(round.origin, undefined);
  assert.equal(round.connected, undefined);
});

test('revoked status round-trips on a connected dataset', () => {
  const d = sample({
    tier: 'asset', visibility: 'domain', origin: 'connected',
    connected: { connectionId: 'c', exposureId: 'e', source: { catalog: 'g', schema: 's', table: 't' }, mode: 'live', tier: 'gold', status: 'source-revoked' },
  });
  const round = parseDataset(serializeDataset(d));
  assert.equal(round.connected?.status, 'source-revoked');
  assert.equal(round.connected?.tier, 'gold');
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

test('docsProvenance is byte-stable: omitted unless ai-auto, round-trips when set', () => {
  // Human-authored/empty docs serialize EXACTLY as before — no `docsProvenance:` key — so
  // no pre-existing record churns.
  const plain = serializeDataset(sample());
  assert.ok(!/(^|\n)docsProvenance:/.test(plain), 'human/empty docs must not emit docsProvenance');
  // An auto-drafted doc is written and survives a round-trip.
  const yaml = serializeDataset(sample({ docsProvenance: 'ai-auto' }));
  assert.match(yaml, /(^|\n)docsProvenance: ai-auto/);
  assert.equal(parseDataset(yaml).docsProvenance, 'ai-auto');
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

// ---- Measure.description ("what does this metric mean?"): nil-safe, byte-stable ----

test('measure description round-trips through serialize/parse', () => {
  const d = sample({ measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', description: 'Total money billed to customers, net of refunds.' }] });
  const round = parseDataset(serializeDataset(d));
  assert.equal(round.measures[0].description, 'Total money billed to customers, net of refunds.');
});

test('measure description is byte-stable: absent when unset, so no prior record churns', () => {
  const bare = sample({ measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }] });
  const yaml = serializeDataset(bare);
  // A measure with no description emits no `description:` key on the measure — byte-identical
  // to before the field existed (the measure builder only ever sets it when non-empty).
  assert.ok(!/description:/.test(yaml.split('measures:')[1] ?? ''), 'a measure with no description must not emit a description key');
  assert.equal(parseDataset(yaml).measures[0].description, undefined);
  // Parse is tolerant: an empty-string description on disk hydrates back to absent.
  const round = parseDataset({ name: 'X', owner: 'a', domain: 'sales', measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', description: '' }] });
  assert.equal(round.measures[0].description, undefined);
});

// ---- DataCheck.description (human-readable rule note): round-trips, empty stays empty ----

test('a data check\'s human description round-trips through serialize/parse', () => {
  const d = sample({ checks: [{
    id: 'chk_1', name: 'not_null(order_id)', description: 'Every order must have an id.',
    createdBy: 'amir', createdAt: '2026-01-01T00:00:00Z', rule: 'not_null', column: 'order_id',
  }] });
  const round = parseDataset(serializeDataset(d));
  assert.equal(round.checks?.[0].description, 'Every order must have an id.');
  // A check with no authored description round-trips as the empty string (never lost/undefined).
  const bare = sample({ checks: [{
    id: 'chk_2', name: 'unique(order_id)', description: '',
    createdBy: 'amir', createdAt: '2026-01-01T00:00:00Z', rule: 'unique', column: 'order_id',
  }] });
  assert.equal(parseDataset(serializeDataset(bare)).checks?.[0].description, '');
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

test('goldSpec derived fields round-trip through serialize/parse (col ref + constant)', () => {
  const goldSpec = {
    joins: [],
    dimensions: [{ source: '0::order_id' }],
    derived: [
      { name: 'margin', left: '0::price', op: '-', right: '0::cost' },
      { name: 'vat', left: '0::price', op: '*', rightValue: 0.19 },
    ],
    measures: [],
  };
  const round = parseDataset(serializeDataset(sample({ goldSpec })));
  assert.deepEqual(round.goldSpec, goldSpec);
});

test('goldSpec derived is byte-stable: absent when no derived fields, so no prior record churns', () => {
  const withDims = { joins: [], dimensions: [{ source: '0::order_id' }], measures: [] };
  const noDerived = serializeDataset(sample({ goldSpec: withDims }));
  // adding an EMPTY derived array serializes identically (absent stays absent)
  assert.equal(serializeDataset(sample({ goldSpec: { ...withDims, derived: [] } })), noDerived);
  assert.equal(parseDataset(noDerived).goldSpec?.derived, undefined);
});

// ---- curated base (goldSpec.baseDatasetId): the EXPLICIT ref-0 base a curated compose builds from ----

test('goldSpec.baseDatasetId round-trips through serialize/parse (curated compose re-hydrates its base)', () => {
  const goldSpec = {
    joins: [],
    dimensions: [{ source: '0::region' }],
    measures: [],
    baseDatasetId: 'ds_orders',
  };
  const round = parseDataset(serializeDataset(sample({ goldSpec })));
  assert.deepEqual(round.goldSpec, goldSpec);
});

test('goldSpec.baseDatasetId is byte-stable: absent for an ingested dataset, so no prior record churns', () => {
  const ingested = { joins: [], dimensions: [{ source: '0::order_id' }], measures: [] };
  const noBase = serializeDataset(sample({ goldSpec: ingested }));
  // Adding an EMPTY/absent baseDatasetId serializes identically to before the field existed.
  assert.equal(serializeDataset(sample({ goldSpec: { ...ingested, baseDatasetId: '' } })), noBase);
  assert.equal(parseDataset(noBase).goldSpec?.baseDatasetId, undefined);
});

test('legacy grandfathering: an INGESTED dataset keeps its stored joins on round-trip (join editor stays visible)', () => {
  // The UI reads `goldSpec.joins.length > 0` to keep the join editor visible for an
  // INGESTED dataset (grandfathering — nothing breaks). Assert the data contract that
  // drives it: an ingest-born dataset can carry joins in its stored spec, byte-stably.
  const goldSpec = {
    joins: [{ datasetId: 'ds_np', type: 'left' as const, baseCol: 'order_id', joinCol: 'order_id' }],
    dimensions: [{ source: '0::order_id' }, { source: '1::region' }],
    measures: [],
  };
  const round = parseDataset(serializeDataset(sample({ origin: 'ingest', goldSpec })));
  assert.equal(round.origin, undefined); // ingest birth still omits origin (byte-stable)
  assert.equal((round.goldSpec?.joins.length ?? 0), 1); // joins survive → legacy editor shows
  assert.deepEqual(round.goldSpec, goldSpec);
});

test('parseGoldSpec keeps a curated base-ONLY spec (a base picked before columns are chosen)', () => {
  const s = parseGoldSpec({ joins: [], dimensions: [], measures: [], baseDatasetId: 'ds_orders' });
  assert.equal(s?.baseDatasetId, 'ds_orders');
  // A truly empty spec (no base, no joins/dims/measures) still collapses to undefined.
  assert.equal(parseGoldSpec({ joins: [], dimensions: [], measures: [], baseDatasetId: '' }), undefined);
});

test('parseGoldSpec parses derived tolerantly: col ref wins over constant; bad constant dropped', () => {
  const s = parseGoldSpec({
    joins: [], dimensions: [{ source: '0::x' }], measures: [],
    derived: [
      { name: 'both', left: '0::a', op: '/', right: '0::b', rightValue: 5 }, // col ref wins
      { name: 'nan', left: '0::a', op: '*', rightValue: Number.NaN }, // non-finite dropped → neither right set
      { name: 'k', left: '0::a', op: '+', rightValue: 2 },
    ],
  });
  assert.equal(s?.derived?.[0].right, '0::b');
  assert.equal(s?.derived?.[0].rightValue, undefined);
  assert.equal(s?.derived?.[1].right, undefined);
  assert.equal(s?.derived?.[1].rightValue, undefined);
  assert.equal(s?.derived?.[2].rightValue, 2);
});

test('parseGoldSpec keeps a derived-only spec (no dims, no measures)', () => {
  const s = parseGoldSpec({ joins: [], dimensions: [], measures: [], derived: [{ name: 'm', left: '0::a', op: '-', right: '0::b' }] });
  assert.equal(s?.derived?.length, 1);
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

test('a composite measure FORMULA survives the serialize→parse round-trip (latent-gap fix)', () => {
  const back = parseDataset(serializeDataset(sample({
    measures: [{ name: 'margin', type: 'number', sql: '1.0 * ({revenue} - {cost})', formula: '[revenue] - [cost]' }],
  })));
  assert.equal(back.measures[0].formula, '[revenue] - [cost]', 'the source formula round-trips');
  assert.equal(back.measures[0].sql, '1.0 * ({revenue} - {cost})');
});
