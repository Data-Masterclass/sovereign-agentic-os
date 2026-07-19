/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset, type Measure } from '../../data/dataset-schema.ts';
import {
  datasetToTmdl,
  daxForMeasure,
  measureMappings,
  tmdlFilename,
  CUBE_TO_DAX,
} from './tmdl.ts';

const ENDPOINT = { host: 'cube-sql.example.com', port: 15432 };

/** A governed Gold dataset fixture (a fake Cube-meta source — no I/O). */
function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1',
    id: 'ds_orders',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Sales orders.',
    versions,
    grants: [],
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Order key.' },
      { name: 'region', description: 'Where the order shipped.' },
      { name: 'net_amount', description: 'Order value.' },
      { name: 'order_date', description: 'When it was placed.' },
    ],
    ...over,
  };
}

// ── Cube measure → DAX mapping fidelity ─────────────────────────────────────────

test('daxForMeasure: sum/avg/min/max/distinct aggregate the measure source column', () => {
  const ref = 'Orders';
  assert.equal(daxForMeasure({ name: 'revenue', type: 'sum', sql: 'net_amount' }, ref), 'SUM(Orders[net_amount])');
  assert.equal(daxForMeasure({ name: 'aov', type: 'avg', sql: 'net_amount' }, ref), 'AVERAGE(Orders[net_amount])');
  assert.equal(daxForMeasure({ name: 'lo', type: 'min', sql: 'net_amount' }, ref), 'MIN(Orders[net_amount])');
  assert.equal(daxForMeasure({ name: 'hi', type: 'max', sql: 'net_amount' }, ref), 'MAX(Orders[net_amount])');
  assert.equal(
    daxForMeasure({ name: 'buyers', type: 'count_distinct', sql: 'customer_id' }, ref),
    'DISTINCTCOUNT(Orders[customer_id])',
  );
});

test('daxForMeasure: count maps to COUNTROWS(table) — no source column', () => {
  assert.equal(daxForMeasure({ name: 'orders', type: 'count', sql: '' }, 'Orders'), 'COUNTROWS(Orders)');
});

test('daxForMeasure: count_distinct_approx honestly mirrors to exact DISTINCTCOUNT', () => {
  assert.equal(
    daxForMeasure({ name: 'u', type: 'count_distinct_approx', sql: 'customer_id' }, 'Orders'),
    'DISTINCTCOUNT(Orders[customer_id])',
  );
});

test('daxForMeasure: a number/derived measure emits its Cube sql expression verbatim', () => {
  const m: Measure = { name: 'margin_pct', type: 'number', sql: '{CUBE}.margin / {CUBE}.revenue' };
  assert.equal(daxForMeasure(m, 'Orders'), '{CUBE}.margin / {CUBE}.revenue');
});

test('CUBE_TO_DAX covers every Cube measure type (no silent gaps)', () => {
  for (const t of ['count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max', 'number'] as const) {
    assert.ok(CUBE_TO_DAX[t], `missing DAX mapping for Cube type ${t}`);
  }
});

// ── measure + dimension fidelity in the emitted TMDL ────────────────────────────

test('datasetToTmdl: emits a table named after the Cube view with the measure as DAX', () => {
  const tmdl = datasetToTmdl(ds(), { endpoint: ENDPOINT });
  assert.match(tmdl, /^table Orders/m);
  assert.match(tmdl, /measure revenue = SUM\(Orders\[net_amount\]\)/);
});

test('datasetToTmdl: every gold dimension column becomes a typed TMDL column', () => {
  const tmdl = datasetToTmdl(ds(), { endpoint: ENDPOINT });
  // string / number / time inference from the column name (reuses inferDimType).
  assert.match(tmdl, /column region\n\t\tdataType: string/);
  assert.match(tmdl, /column net_amount\n\t\tdataType: double/);
  assert.match(tmdl, /column order_date\n\t\tdataType: dateTime/);
  // order_id is `*_id` → number/double.
  assert.match(tmdl, /column order_id\n\t\tdataType: double/);
});

test('datasetToTmdl: a column that shares a measure name is NOT emitted twice', () => {
  // measure `region_count` + a `region_count` column: the measure wins (mirror Cube).
  const d = ds({
    measures: [{ name: 'region_count', type: 'count', sql: '' }],
    columns: [{ name: 'region_count', description: 'clash' }, { name: 'region', description: 'ok' }],
  });
  const tmdl = datasetToTmdl(d, { endpoint: ENDPOINT });
  assert.match(tmdl, /measure region_count = COUNTROWS\(Orders\)/);
  assert.doesNotMatch(tmdl, /column region_count/);
});

test('datasetToTmdl: measure format maps to a TMDL formatString', () => {
  const d = ds({ measures: [{ name: 'rev', type: 'sum', sql: 'net_amount', format: 'currency' }] });
  const tmdl = datasetToTmdl(d, { endpoint: ENDPOINT });
  assert.match(tmdl, /formatString: \\\$#,0\.00/);
});

test('datasetToTmdl: an empty measure list defaults to a count measure (never empty)', () => {
  const tmdl = datasetToTmdl(ds({ measures: [] }), { endpoint: ENDPOINT });
  assert.match(tmdl, /measure count = COUNTROWS\(Orders\)/);
});

// ── RLS / identity preserved in the datasource binding ──────────────────────────

test('datasetToTmdl: partition binds DirectQuery to the endpoint as the bi_<domain> principal', () => {
  const tmdl = datasetToTmdl(ds(), { endpoint: ENDPOINT });
  // DirectQuery (never Import) → the governed filter re-runs live, no ungoverned snapshot.
  assert.match(tmdl, /mode: directQuery/);
  // The datasource points at the governed Cube SQL endpoint.
  assert.match(tmdl, /cube-sql\.example\.com:15432/);
  // ...logging in as the domain's read-only BI principal (Cube → Trino → OPA RLS).
  assert.match(tmdl, /bi_sales/);
  // It queries the governed VIEW, not a raw table.
  assert.match(tmdl, /SELECT \* FROM/);
  assert.match(tmdl, /Orders/);
});

test('datasetToTmdl: different domains produce different principals — no cross-domain bleed', () => {
  const sales = datasetToTmdl(ds({ domain: 'sales' }), { endpoint: ENDPOINT });
  const finance = datasetToTmdl(ds({ domain: 'finance' }), { endpoint: ENDPOINT });
  assert.match(sales, /bi_sales/);
  assert.match(finance, /bi_finance/);
  assert.doesNotMatch(finance, /bi_sales/);
});

test('datasetToTmdl: NEVER embeds a password (Power BI prompts)', () => {
  const tmdl = datasetToTmdl(ds(), { endpoint: ENDPOINT });
  assert.doesNotMatch(tmdl, /password/i);
  assert.doesNotMatch(tmdl, /credential/i);
});

test('datasetToTmdl: an invalid/empty domain is rejected (no empty-scope principal)', () => {
  assert.throws(() => datasetToTmdl(ds({ domain: '' }), { endpoint: ENDPOINT }), /invalid|empty/i);
});

// ── honest one-way provenance in the emitted text ───────────────────────────────

test('datasetToTmdl: header states GENERATED + one-way + no write-back + no XMLA', () => {
  const tmdl = datasetToTmdl(ds(), { endpoint: ENDPOINT });
  assert.match(tmdl, /GENERATED/);
  assert.match(tmdl, /ONE-WAY/i);
  assert.match(tmdl, /No write-back|no write-back/i);
  assert.match(tmdl, /no live XMLA|no live XMLA endpoint/i);
});

// ── namespaced (#155) cube identity round-trips into the table/view name ─────────

test('datasetToTmdl: a #155-namespaced dataset uses its domain-namespaced view name', () => {
  const tmdl = datasetToTmdl(ds({ cubeNamespaced: true }), { endpoint: ENDPOINT });
  assert.match(tmdl, /table sales__Orders/);
  // The native query selects the namespaced view (quotes are backslash-escaped inside the
  // JSON-encoded M source string, so match the view name rather than the raw doubled quotes).
  assert.match(tmdl, /SELECT \* FROM.*sales__Orders/);
  assert.match(tmdl, /partition sales__Orders/);
});

// ── mapping table + filename ────────────────────────────────────────────────────

test('measureMappings: returns the Cube→DAX row for each measure', () => {
  const rows = measureMappings(
    ds({
      measures: [
        { name: 'revenue', type: 'sum', sql: 'net_amount', format: 'currency' },
        { name: 'orders', type: 'count', sql: '' },
      ],
    }),
  );
  assert.deepEqual(rows, [
    { measure: 'revenue', cubeType: 'sum', dax: 'SUM(Orders[net_amount])', formatString: '\\$#,0.00' },
    { measure: 'orders', cubeType: 'count', dax: 'COUNTROWS(Orders)', formatString: null },
  ]);
});

test('tmdlFilename: is the view name with a .tmdl extension', () => {
  assert.equal(tmdlFilename(ds()), 'Orders.tmdl');
  assert.equal(tmdlFilename(ds({ cubeNamespaced: true })), 'sales__Orders.tmdl');
});
