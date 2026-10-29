/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaffoldMetricYaml,
  inferDimType,
  modelName,
  viewName,
  legacyModelName,
  legacyViewName,
  modelNameMatches,
  viewNameMatches,
  CUBE_ARTIFACT,
  goldMartFqn,
  goldOutputColumns,
  metricSqlReady,
  viewMembers,
} from '@tabs/data/lib/metrics';
import { emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';

function gold(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true; versions.silver.built = true; versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'order_date', description: 'When.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

test('cube_dbt scaffolds dimensions from columns; user-named measure is included', () => {
  const yaml = scaffoldMetricYaml(gold());
  assert.match(yaml, /sql_table: iceberg\.sales\.gold_orders/);
  assert.match(yaml, /name: revenue\n\s+type: sum\n\s+sql: net_amount/);
  assert.match(yaml, /name: order_id[\s\S]*primary_key: true/); // PK dimension
  assert.match(yaml, /- name: Orders/); // the view
  assert.match(yaml, /includes: \[revenue, order_date, region, net_amount\]/);
});

test('goldOutputColumns: a Gold JOIN projects its OWN output columns (aliases + joined cols), not the base docs', () => {
  const d = gold({
    goldSpec: {
      joins: [{ datasetId: 'ds_products', type: 'inner', baseCol: 'product_id', joinCol: 'product_id' }],
      dimensions: [
        { source: '0::order_id' },                       // base column, name kept
        { source: '0::net_amount', as: 'net' },          // base column, RENAMED in gold
        { source: '1::product_name' },                   // JOINED column (not in d.columns)
      ],
      measures: [],
    },
  });
  const cols = goldOutputColumns(d);
  assert.deepEqual(cols.map((c) => c.name), ['order_id', 'net', 'product_name']);
  assert.equal(cols[0].description, 'Key.'); // base doc carried over by name
  assert.equal(cols[1].description, 'Value.'); // doc carried via the SOURCE column
  assert.equal(cols[2].description, ''); // joined column has no base doc
  // …and the Cube scaffold binds its dimensions to the SAME gold output set.
  const yaml = scaffoldMetricYaml(d);
  assert.match(yaml, /- name: product_name/);
  assert.match(yaml, /- name: net\n/);
  assert.doesNotMatch(yaml, /- name: region/); // unprojected base column is NOT a dim
});

test('goldOutputColumns: pass-through / spec-less gold falls back to the documented columns', () => {
  const d = gold();
  assert.deepEqual(goldOutputColumns(d).map((c) => c.name), ['order_id', 'order_date', 'region', 'net_amount']);
});

test('goldOutputColumns: derived field names appear in the output set (dims + derived)', () => {
  const d = gold({
    goldSpec: {
      joins: [],
      dimensions: [{ source: '0::order_id' }],
      derived: [{ name: 'margin', left: '0::net_amount', op: '-', right: '0::region' }],
      measures: [],
    },
  });
  assert.deepEqual(goldOutputColumns(d).map((c) => c.name), ['order_id', 'margin']);
  // …and the Cube scaffold binds a dimension to the derived output column.
  assert.match(scaffoldMetricYaml(d), /- name: margin/);
});

test('goldOutputColumns: a derived-only spec (no dims) still surfaces the derived column', () => {
  const d = gold({
    goldSpec: {
      joins: [], dimensions: [],
      derived: [{ name: 'margin', left: '0::net_amount', op: '*', rightValue: 2 }],
      measures: [],
    },
  });
  assert.deepEqual(goldOutputColumns(d).map((c) => c.name), ['margin']);
});

test('dim types are inferred cube_dbt-style from the column names', () => {
  assert.equal(inferDimType('order_date'), 'time');
  assert.equal(inferDimType('created_at'), 'time');
  assert.equal(inferDimType('net_amount'), 'number');
  assert.equal(inferDimType('customer_id'), 'number');
  assert.equal(inferDimType('is_active'), 'boolean');
  assert.equal(inferDimType('region'), 'string');
});

test('a measure-less gold still scaffolds a count cube (so the view is valid)', () => {
  const y = scaffoldMetricYaml(gold({ measures: [] }));
  assert.match(y, /name: count\n\s+type: count/);
  // #142: the default cube-level `count` must ALSO be in the view `includes`, or the
  // view exposes no measure at all (the empty Northpeak_Campaigns symptom).
  assert.match(y, /includes: \[count, /);
});

test('the richer Cube measure fields emit only when present (plain measures unchanged)', () => {
  const y = scaffoldMetricYaml(gold({
    measures: [{
      name: 'completed_revenue', type: 'sum', sql: 'net_amount',
      filters: [{ sql: "{CUBE}.status = 'completed'" }],
      rollingWindow: { trailing: '7 day', offset: 'end' },
      format: 'currency',
      drillMembers: ['order_id', 'region'],
    }],
  }));
  assert.match(y, /filters:\n\s+- sql: "\{CUBE\}\.status = 'completed'"/);
  assert.match(y, /rolling_window:\n\s+trailing: 7 day\n\s+offset: end/);
  assert.match(y, /format: currency/);
  assert.match(y, /drill_members: \[order_id, region\]/);
  // A plain measure alongside it emits NO rich blocks (no leakage).
  const plain = scaffoldMetricYaml(gold());
  assert.doesNotMatch(plain, /filters:|rolling_window:|format:|drill_members:/);
});

test('handover names line up across cube + exposure + dashboard', () => {
  const d = gold();
  assert.equal(goldMartFqn(d), 'iceberg.sales.gold_orders');
  assert.equal(viewName(d), 'Orders');
});

// -------- metrics→Trino: the SQL-ready gate --------

test('metricSqlReady: a PERSONAL built Gold is now READY (define/preview/explore drop promote-first)', () => {
  // The whole point of Phase 1 — a metric serves as governed Trino SQL over the personal
  // lane read AS the owner, so no promotion is needed to define or read it.
  const personal = gold({ tier: 'dataset', visibility: 'private' });
  assert.deepEqual(metricSqlReady(personal), { ok: true });
});

test('metricSqlReady: still requires a built Gold (no gold → honest reject)', () => {
  const noGold = gold();
  noGold.versions.gold.built = false;
  assert.equal(metricSqlReady(noGold).ok, false);
  assert.match(metricSqlReady(noGold).message!, /built Gold/);
});

test('metricSqlReady: a LIVE connected dataset is EXCLUDED as a metric source (synced-copy steer)', () => {
  // Even with a "built" gold layer, a live-federated external table has no governed gold
  // mart to bind a metric to — the picker + define route both surface this steer.
  const live = gold({
    origin: 'connected',
    connected: { connectionId: 'c', exposureId: 'e', source: { catalog: 'g', schema: 's', table: 't' }, mode: 'live', tier: 'gold', status: 'ok' },
  });
  const r = metricSqlReady(live);
  assert.equal(r.ok, false);
  assert.match(r.message!, /synced copy/i);
});

test('#91 dim reconciliation: drill_members naming a NON-mart column are dropped from the cube', () => {
  // net_amount + region are mart columns; ghost_col is NOT — it must never be emitted.
  const y = scaffoldMetricYaml(gold({
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', drillMembers: ['region', 'ghost_col', 'net_amount'] }],
  }));
  assert.match(y, /drill_members: \[region, net_amount\]/); // known members kept, in order
  assert.doesNotMatch(y, /ghost_col/); // the unknown column never reaches the YAML
});

test('#91 dim reconciliation: an all-unknown drill_members list emits NO drill_members block', () => {
  const y = scaffoldMetricYaml(gold({
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', drillMembers: ['nope', 'gone'] }],
  }));
  assert.doesNotMatch(y, /drill_members:/);
});

test('viewMembers = the Cube VIEW includes set: measures + non-PK dims, PK EXCLUDED', () => {
  const members = viewMembers(gold());
  // measures + non-pk dimension columns are members…
  assert.deepEqual([...members].sort(), ['net_amount', 'order_date', 'region', 'revenue']);
  // …the PRIMARY KEY (order_id) is a cube dimension but NOT a view member (the 400 fix).
  assert.equal(members.has('order_id'), false);
  // viewMembers stays in lockstep with the YAML `includes` list.
  const yaml = scaffoldMetricYaml(gold());
  assert.match(yaml, /includes: \[revenue, order_date, region, net_amount\]/);
});

test('viewMembers matches a PK named like the dataset (e.g. campaign_id) — the reported 400', () => {
  const members = viewMembers(gold({
    columns: [
      { name: 'campaign_id', description: 'PK.' },
      { name: 'clicks', description: 'n.' },
    ],
    measures: [{ name: 'total_clicks', type: 'sum', sql: 'clicks' }],
  }));
  assert.equal(members.has('campaign_id'), false); // PK excluded → picker/explorer drop it
  assert.equal(members.has('clicks'), true);
  assert.equal(members.has('total_clicks'), true);
});

// ------------------------------------------------------ #155 domain-namespaced cube ---

test('#155 legacy dataset (no marker) keeps its EXACT un-namespaced identity (byte-stable)', () => {
  const d = gold(); // no viewNamespaced → the pre-#155 / live-tenant shape
  assert.equal(modelName(d), 'orders');
  assert.equal(viewName(d), 'Orders');
  assert.equal(CUBE_ARTIFACT(d), 'metrics/orders.cube.yml');
  // The whole model YAML is unchanged from before #155 — the live Cube model is untouched.
  assert.match(scaffoldMetricYaml(d), /- name: orders\n/);
  assert.match(scaffoldMetricYaml(d), /- name: Orders\n/);
});

test('#155 new dataset (marker) gets a DOMAIN-NAMESPACED cube name / view / file', () => {
  const d = gold({ viewNamespaced: true });
  assert.equal(modelName(d), 'sales__orders');
  assert.equal(viewName(d), 'sales__Orders');
  assert.equal(CUBE_ARTIFACT(d), 'metrics/sales__orders.cube.yml');
  assert.match(scaffoldMetricYaml(d), /- name: sales__orders\n/);
  assert.match(scaffoldMetricYaml(d), /- name: sales__Orders\n/);
});

test('#155 two domains, SAME dataset name → DISTINCT cube/view/file identities (no collision)', () => {
  const sales = gold({ domain: 'sales', name: 'Sales', viewNamespaced: true });
  const finance = gold({ domain: 'finance', name: 'Sales', viewNamespaced: true });
  // cube name, view name and the emitted model file are all distinct per domain…
  assert.notEqual(modelName(sales), modelName(finance));
  assert.notEqual(viewName(sales), viewName(finance));
  assert.notEqual(CUBE_ARTIFACT(sales), CUBE_ARTIFACT(finance));
  assert.equal(modelName(sales), 'sales__sales');
  assert.equal(modelName(finance), 'finance__sales');
  assert.equal(CUBE_ARTIFACT(sales), 'metrics/sales__sales.cube.yml');
  assert.equal(CUBE_ARTIFACT(finance), 'metrics/finance__sales.cube.yml');
});

test('#155 back-compat resolver: a namespaced dataset still answers to its LEGACY bare name', () => {
  const d = gold({ domain: 'sales', name: 'Sales', viewNamespaced: true });
  // The legacy names an existing dashboard / Power BI query / metric member would use…
  assert.equal(legacyModelName(d), 'sales');
  assert.equal(legacyViewName(d), 'Sales');
  // …still resolve to this dataset, alongside the new namespaced name.
  assert.ok(modelNameMatches(d, 'sales'));          // legacy reference resolves
  assert.ok(modelNameMatches(d, 'sales__sales'));   // new namespaced name resolves
  assert.ok(!modelNameMatches(d, 'finance__sales')); // another domain's cube does NOT
  assert.ok(viewNameMatches(d, 'Sales'));         // legacy view reference resolves
  assert.ok(viewNameMatches(d, 'sales__Sales'));  // new namespaced view resolves
});

test('#155 legacy dataset resolves under its bare name (matcher is a superset of legacy)', () => {
  const d = gold(); // no marker
  assert.ok(modelNameMatches(d, 'orders'));
  assert.ok(viewNameMatches(d, 'Orders'));
});

// ---------------------------------- FROZEN slug — Cube/dbt identity stability on rename --

// A rename FREEZES the slug; the Cube name, view, gold-mart FQN and dbt mart ref all stay
// pinned to the original physical identity — a live dashboard/metric never breaks.
test('rename freezes the Cube + dbt identity (legacy, un-namespaced dataset)', () => {
  const before = gold({ name: 'Orders' });          // no slug → slug("Orders") = "orders"
  assert.equal(modelName(before), 'orders');
  assert.equal(viewName(before), 'Orders');
  assert.equal(goldMartFqn(before), 'iceberg.sales.gold_orders');

  // Rename "Orders" → "Sales Orders" pins slug="orders" (what renameDataset does).
  const after = gold({ name: 'Sales Orders', slug: 'orders' });
  assert.equal(modelName(after), 'orders', 'cube name must NOT move to sales_orders');
  // The view stays anchored to the frozen slug BUT may not EQUAL the cube name: Cube
  // rejects the entire schema on "conflicting cube and view name" (one bad model 500s
  // /meta for every dataset), so the identifier is disambiguated by case — Cube
  // identifiers are case-sensitive. legacyViewName + viewNameMatches keep any
  // stored reference to the old name resolving, so nothing that referenced it breaks.
  assert.equal(viewName(after), 'Orders', 'view anchored to the frozen slug, disambiguated from the cube');
  assert.notEqual(viewName(after), modelName(after), 'a view may never share its cube name');
  assert.equal(goldMartFqn(after), 'iceberg.sales.gold_orders', 'gold mart FQN frozen');
  assert.doesNotMatch(goldMartFqn(after), /sales_orders/);
});

// The SAME freeze holds for a #155 namespaced dataset — only the domain prefix + frozen slug.
test('rename freezes the Cube identity (namespaced #155 dataset)', () => {
  const after = gold({ name: 'Sales Orders', slug: 'orders', viewNamespaced: true });
  assert.equal(modelName(after), 'sales__orders');
  // Disambiguated from the cube name (same rule as the legacy test above) — never equal.
  assert.equal(viewName(after), 'sales__Orders');
  assert.notEqual(viewName(after), modelName(after), 'a view may never share its cube name');
  // The legacy bare name still resolves to the frozen slug (back-compat unbroken).
  assert.ok(modelNameMatches(after, 'orders'));
});
