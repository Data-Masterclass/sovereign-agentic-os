/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The data-product parity gate (engine rebuild B3, checklist D15)
 * USER STORY: As the person who will delete the TypeScript CTAS path I want one test that says, per
 *             fixture, whether the dbt model means the same thing as the CTAS the OS runs today —
 *             and that FAILS if any compiled model drifts, so the flag flip in B4 has a gate.
 * ARCHITECTURE:
 *   - Pure: the same literal fixtures the generator goldens use, driven through `compileSilver` /
 *     `compileGoldJoin` (today's executor) and `planModels` (tomorrow's), compared by
 *     `tabs/data/lib/dbt/parity.ts`. No store, no Trino, no cluster.
 *   - The worked example of the concept document (`gold_order_customer`, domain `sales`) is a named
 *     fixture of its own so the example in the plan is the thing that is tested.
 *   - A model with no recorded CTAS is reported `skipped` with its reason. The gate asserts that
 *     every COMPILED model is at parity and that the expected number of them were compared — so a
 *     generator change that turns a compiled model into something else fails here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { compileGoldJoin, compileSilver } from '@tabs/data/lib/transform';
import { planModels } from '@tabs/data/lib/dbt/models';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { parityReport, compareSelects, selectShape, resolveJinja, normalizeSql, substitutionsFor, ctasTarget } from '@tabs/data/lib/dbt/parity';

function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return {
    version: '1',
    tier: 'dataset',
    visibility: 'private',
    folder: '/',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
    viewNamespaced: true,
    ...input,
  };
}

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
const unbuilt = { built: false, passThrough: false, quality: 'unknown' as const, updatedAt: null, artifact: null };

// ---------------------------------------------------------------------------------------------
// The worked example of 2026-11-13-data-products-concept.md §7: Alex composes shared Silver
// `orders` and `customers` (inner join on customer_id, sum(amount)) in domain `sales`.
const silverOrdersSql = compileSilver({
  source: 'iceberg.personal_amir.bronze_orders',
  target: 'iceberg.personal_amir.silver_orders',
  columns: ['order_id', 'customer_id', 'amount'],
  ops: [{ kind: 'cast', column: 'amount', type: 'double' }, { kind: 'filter', column: 'order_id', op: 'not_null' }],
});
const goldOrderCustomerSql = compileGoldJoin({
  source: 'iceberg.personal_amir.silver_orders',
  joins: [{ table: 'iceberg.sales.silver_customers', type: 'inner', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
  dimensions: [{ col: { ref: 0, column: 'customer_id' } }, { col: { ref: 1, column: 'customer_name' } }],
  measures: [{ name: 'total_amount', agg: 'sum', col: { ref: 0, column: 'amount' } }],
  target: 'iceberg.personal_amir.gold_order_customer',
});

type Fixture = { name: string; snapshot: ProjectSnapshot; compiledModels: number };

function workedExample(): Fixture {
  const orders = ds({
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    columns: [{ name: 'order_id', description: 'Order key' }, { name: 'customer_id', description: '' }, { name: 'amount', description: 'Net amount' }],
    versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql'), gold: unbuilt },
  });
  const customers = ds({
    id: 'ds_cust0001',
    name: 'Customers',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    columns: [{ name: 'customer_id', description: 'Customer key' }, { name: 'customer_name', description: 'Display name' }],
    versions: { bronze: built('bronze/customers.dlt.yml'), silver: built('silver/stg_customers.sql', true), gold: unbuilt },
  });
  const composition = ds({
    id: 'ds_oc000001',
    name: 'Order Customer',
    owner: 'amir',
    domain: 'sales',
    origin: 'curated',
    columns: [{ name: 'customer_id', description: 'Customer key' }, { name: 'customer_name', description: '' }, { name: 'total_amount', description: 'Sum of order amounts' }],
    versions: { bronze: unbuilt, silver: unbuilt, gold: built('gold/mart_order_customer.sql') },
    upstreams: [
      { datasetId: 'ds_orders1', name: 'Orders', fqn: 'iceberg.personal_amir.silver_orders', joinType: 'inner' },
      { datasetId: 'ds_cust0001', name: 'Customers', fqn: 'iceberg.sales.silver_customers', joinType: 'inner' },
    ],
  });
  return {
    name: 'gold_order_customer (concept §7)',
    compiledModels: 2,
    snapshot: {
      domain: 'sales',
      datasets: [
        { dataset: orders, artifacts: { 'silver/stg_orders.sql': silverOrdersSql }, compiled: ['silver/stg_orders.sql'] },
        { dataset: customers, artifacts: {} },
        { dataset: composition, artifacts: { 'gold/mart_order_customer.sql': goldOrderCustomerSql }, compiled: ['gold/mart_order_customer.sql'] },
      ],
      catalogs: {},
    },
  };
}

function ingestedPassThrough(): Fixture {
  const orders = ds({
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    columns: [{ name: 'order_id', description: 'Order key' }, { name: '_loaded_at', description: 'Ingest timestamp' }],
    versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql', true), gold: built('gold/mart_orders.sql', true) },
  });
  return { name: 'ingested-pass-through', compiledModels: 0, snapshot: { domain: 'sales', datasets: [{ dataset: orders, artifacts: {} }], catalogs: {} } };
}

function appendSync(): Fixture {
  const events = ds({
    id: 'ds_events01',
    name: 'Events',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    origin: 'connected',
    connected: { connectionId: 'conn_wh', exposureId: 'exp_1', source: { catalog: 'wh', schema: 'public', table: 'events' }, mode: 'sync', tier: 'silver', status: 'ok' },
    sync: { connectionId: 'conn_wh', source: { schema: 'public', table: 'events' }, mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' }, schedule: { cron: '*/15 * * * *' }, enabled: true },
    versions: { ...emptyVersions(), silver: built(null) },
  });
  return { name: 'append-sync-with-cursor', compiledModels: 0, snapshot: { domain: 'sales', datasets: [{ dataset: events, artifacts: {} }], catalogs: { conn_wh: 'wh' } } };
}

const FIXTURES: Fixture[] = [workedExample(), ingestedPassThrough(), appendSync()];

function artifactsOf(f: Fixture) {
  return (datasetId: string, layer: string): string | undefined => {
    const entry = f.snapshot.datasets.find((d) => d.dataset.id === datasetId);
    const path = entry?.dataset.versions[layer as 'silver']?.artifact;
    return path ? entry?.artifacts[path] : undefined;
  };
}

for (const f of FIXTURES) {
  test(`parity: ${f.name}`, () => {
    const plan = planModels(f.snapshot);
    const results = parityReport(f.name, plan, artifactsOf(f));
    const compared = results.filter((r) => !r.skipped);
    const failed = compared.filter((r) => !r.ok);
    assert.deepEqual(
      failed.map((r) => `${r.model}: ${r.mismatches.join(' | ')}`),
      [],
      `${f.name}: every compiled model must mean what the CTAS meant`,
    );
    assert.equal(compared.length, f.compiledModels, `${f.name}: expected ${f.compiledModels} compiled model(s) to compare`);
    // Nothing is silently unexamined: every model is either compared or skipped WITH a reason.
    assert.ok(results.every((r) => r.skipped || compared.includes(r)));
  });
}

test('negative control: a drifted model, or one whose ref cannot be resolved, FAILS', () => {
  // The model body IS the recorded CTAS after rewriting (deviation B1-2), so drift can only be
  // introduced on one SIDE of the comparison — which is exactly what a future change to the
  // rewriter, the stripper or the lane/FQN mapping would do. Both are reported, neither accepted.
  const ctas = goldOrderCustomerSql.replace(/^create or replace table \S+ as /i, '');
  const joinMismatch = compareSelects(ctas, ctas.replace('inner join', 'left join'));
  assert.equal(joinMismatch.length, 1);
  assert.match(joinMismatch[0], /^joins: CTAS .*"inner".* vs dbt .*"left"/);
  // A projection that lost a column.
  assert.ok(compareSelects(ctas, ctas.replace(', sum(t0."amount") as "total_amount"', '')).some((m) => m.startsWith('output columns:')));
  // An unresolved `{{ ref() }}` (a mapping the planner no longer agrees with) leaves Jinja in the
  // SQL, which is not a shape the harness will read — a mismatch, never a pass.
  const unresolved = resolveJinja(`select "a" from {{ ref('gone') }} t0`, new Map(), new Map());
  assert.match(unresolved, /\{\{ ref\('gone'\) \}\}/);
  assert.ok(compareSelects(ctas, unresolved).length > 0, 'an unresolved ref must be reported');
});

test('the worked example is compared on its real projection, joins and group by', () => {
  const f = workedExample();
  const plan = planModels(f.snapshot);
  const gold = plan.models.find((m) => m.name === 'gold_order_customer')!;
  const { refs, sources } = { refs: new Map(plan.models.map((m) => [m.name, `iceberg.${m.schema}.${m.name}`])), sources: new Map<string, string>() };
  const resolved = resolveJinja(gold.sql.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim(), refs, sources);
  const shape = selectShape(resolved)!;
  assert.deepEqual(shape.columns, [
    { expr: 't0."customer_id"', alias: '"customer_id"' },
    { expr: 't1."customer_name"', alias: '"customer_name"' },
    { expr: 'sum(t0."amount")', alias: '"total_amount"' },
  ]);
  assert.deepEqual(shape.joins, [{ type: 'inner', rel: 'iceberg.sales.silver_customers t1', on: 't0."customer_id" = t1."customer_id"' }]);
  assert.equal(shape.from, 'iceberg.personal_amir.silver_orders t0');
  assert.deepEqual(shape.groupBy, ['t0."customer_id"', 't1."customer_name"']);
  assert.deepEqual(compareSelects(goldOrderCustomerSql.replace(/^create or replace table \S+ as /i, ''), resolved), []);
});

test('an unreadable shape is a mismatch, never a pass; WHERE order does not matter', () => {
  assert.deepEqual(selectShape('update t set x = 1'), null);
  assert.deepEqual(selectShape('select 1'), null, 'no FROM: not a shape the OS compilers produce');
  assert.deepEqual(compareSelects('select * from a', 'with x as (select 1) select * from x'), ['the generated model body is not a shape the harness can read']);
  assert.deepEqual(
    compareSelects('select "a" from t where "a" > 1 and "b" < 2', 'select "a" from t where "b" < 2 and "a" > 1'),
    [],
    'conjuncts are compared as a set',
  );
  assert.ok(compareSelects('select "a" from t', 'select "b" from t').length > 0);
  assert.equal(normalizeSql('  select\n  1 -- note\n'), 'select 1');
});

// ------------------------------------------------- B3 review round (B3-review-M-6) ---

test('a WRONG lane mapping now FAILS — the harness no longer checks the plan against itself', () => {
  // The defect: `substitutionsFor` built its `ref()` map from the SAME plan `rewriteFqns` used, so
  // a plan that disagrees with the FQN the OS actually wrote produced a consistently-wrong round
  // trip and passed. Here the Orders dataset is owned by `zed` (plan schema `personal_zed`) while
  // the recorded CTAS wrote `iceberg.personal_amir.silver_orders` — so the rewriter's model lookup
  // misses and emits the model as an EXTERNAL `source()`. dbt would build no edge, run the models
  // in the wrong order and read a table the model does not own.
  const base = workedExample();
  const wrong: ProjectSnapshot = {
    ...base.snapshot,
    datasets: base.snapshot.datasets.map((d) =>
      d.dataset.id === 'ds_orders1' ? { ...d, dataset: { ...d.dataset, owner: 'zed' } } : d,
    ),
  };
  const plan = planModels(wrong);
  const results = parityReport('wrong-lane-mapping', plan, artifactsOf({ ...base, snapshot: wrong }));
  const gold = results.find((r) => r.model === 'gold_order_customer')!;
  assert.equal(gold.ok, false, 'a lane mapping that disagrees with the recorded CTAS must FAIL');
  assert.ok(
    gold.mismatches.some((m) => /is this project's model "silver_orders" but is read as source\(/.test(m)),
    `expected a source/ref conflict, got: ${gold.mismatches.join(' | ')}`,
  );
  // The CORRECT mapping still passes, so this is a real discriminator and not a blanket failure.
  const right = parityReport('worked', planModels(base.snapshot), artifactsOf(base));
  assert.deepEqual(right.filter((r) => !r.skipped && !r.ok), []);
});

test('ref() resolves to the FQN the OS WROTE, not the one the plan assumed', () => {
  const f = workedExample();
  const plan = planModels(f.snapshot);
  const { refs, modelTargets } = substitutionsFor(plan, artifactsOf(f));
  assert.equal(refs.get('silver_orders'), 'iceberg.personal_amir.silver_orders');
  assert.equal(modelTargets.get('iceberg.personal_amir.silver_orders'), 'silver_orders');
  // A model the OS never compiled has no recorded target and keeps the plan's FQN — all there is.
  const noCtas = substitutionsFor(plan, () => undefined);
  assert.equal(noCtas.refs.get('silver_orders'), 'iceberg.personal_amir.silver_orders');
  assert.equal(ctasTarget('CREATE OR REPLACE TABLE iceberg.sales.x AS select 1'), 'iceberg.sales.x');
  assert.equal(ctasTarget('select 1'), null);
});
