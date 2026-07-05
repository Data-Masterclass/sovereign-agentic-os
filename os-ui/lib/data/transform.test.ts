/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSilver,
  publishPlan,
  silverPlan,
  silverSchema,
  personalSchema,
  compileGoldJoin,
  goldJoinPlan,
  goldMeasureToCube,
  TransformError,
  type SilverSpec,
  type TransformOp,
} from './transform.ts';

/**
 * These tests double as an executable spec of the query-tool `/execute` allowlist
 * (images/query-tool/execute_guard.py): every compiled statement is asserted to be a
 * single, comment-free `CREATE OR REPLACE TABLE iceberg.<schema>.<table> AS SELECT …`
 * whose target is the CALLER's own schema. If the guard shape changes, these fail.
 */

const SRC = 'iceberg.personal_alex.bronze_returns';
const TGT = 'iceberg.personal_alex.silver_returns';
const COLS = ['order_id', 'region', 'amount', 'status'];

function spec(ops: TransformOp[], columns = COLS): SilverSpec {
  return { source: SRC, target: TGT, columns, ops };
}

/** The exact shape the /execute guard's CTAS regexes require (single statement). */
function assertGuardShape(sql: string): void {
  assert.doesNotMatch(sql, /--|\/\*|\*\//, 'no SQL comments'); // guard rejects comments
  assert.ok(!sql.includes(';'), 'no statement separator');
  assert.equal(sql.trim(), sql, 'no leading/trailing whitespace');
  // The CREATE OR REPLACE TABLE … AS SELECT shape, iceberg catalog, bare identifiers.
  assert.match(
    sql,
    /^create or replace table iceberg\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]* as select\b/,
  );
}

test('bare pass — every column projected, no WHERE, guard-shape holds', () => {
  const sql = compileSilver(spec([]));
  assertGuardShape(sql);
  assert.equal(
    sql,
    'create or replace table iceberg.personal_alex.silver_returns as select "order_id", "region", "amount", "status" from iceberg.personal_alex.bronze_returns',
  );
});

test('rename compiles to an aliased projection', () => {
  const sql = compileSilver(spec([{ kind: 'rename', column: 'amount', to: 'net_amount' }]));
  assertGuardShape(sql);
  assert.match(sql, /"amount" as "net_amount"/);
});

test('cast wraps the column expression in cast(… as <type>)', () => {
  const sql = compileSilver(spec([{ kind: 'cast', column: 'amount', type: 'double' }]));
  assertGuardShape(sql);
  assert.match(sql, /cast\("amount" as double\) as "amount"/);
});

test('trim and normalize wrap the expression', () => {
  const t = compileSilver(spec([{ kind: 'trim', column: 'region' }]));
  assert.match(t, /trim\("region"\) as "region"/);
  const n = compileSilver(spec([{ kind: 'normalize', column: 'region' }]));
  assert.match(n, /lower\(trim\("region"\)\) as "region"/);
});

test('drop removes the column from the projection', () => {
  const sql = compileSilver(spec([{ kind: 'drop', column: 'status' }]));
  assertGuardShape(sql);
  assert.doesNotMatch(sql, /"status"/);
  assert.match(sql, /"order_id", "region", "amount" from/);
});

test('filter — comparison, not_null and not_blank compile into one WHERE', () => {
  const cmp = compileSilver(spec([{ kind: 'filter', column: 'amount', op: '>', value: '100' }]));
  assert.match(cmp, /where "amount" > 100$/); // numeric literal, not quoted

  const str = compileSilver(spec([{ kind: 'filter', column: 'region', op: '=', value: 'EU' }]));
  assert.match(str, /where "region" = 'EU'$/); // string literal, quoted

  const nn = compileSilver(spec([{ kind: 'filter', column: 'region', op: 'not_null' }]));
  assert.match(nn, /where "region" is not null$/);

  const nb = compileSilver(spec([{ kind: 'filter', column: 'status', op: 'not_blank' }]));
  assert.match(nb, /where "status" is not null and trim\(cast\("status" as varchar\)\) <> ''$/);
});

test('multiple filters AND together', () => {
  const sql = compileSilver(
    spec([
      { kind: 'filter', column: 'region', op: '=', value: 'EU' },
      { kind: 'filter', column: 'amount', op: '>=', value: '0' },
    ]),
  );
  assert.match(sql, /where "region" = 'EU' and "amount" >= 0$/);
});

test('dedupe with keys builds a ROW_NUMBER subquery filtered to rn = 1', () => {
  const sql = compileSilver(spec([{ kind: 'dedupe', keys: ['order_id'] }]));
  assertGuardShape(sql);
  assert.match(
    sql,
    /from \(select .* row_number\(\) over \(partition by "order_id" order by "order_id"\) as _dedup_rn from iceberg\.personal_alex\.bronze_returns\) where _dedup_rn = 1$/,
  );
});

test('dedupe without keys is SELECT DISTINCT', () => {
  const sql = compileSilver(spec([{ kind: 'dedupe', keys: [] }]));
  assertGuardShape(sql);
  assert.match(sql, /as select distinct "order_id"/);
});

test('dedupe + typed dates produces a correct, guard-passing CTAS', () => {
  const sql = compileSilver(
    spec([
      { kind: 'cast', column: 'order_id', type: 'bigint' },
      { kind: 'cast', column: 'status', type: 'date' }, // "typed dates"
      { kind: 'dedupe', keys: ['order_id'] },
    ]),
  );
  assertGuardShape(sql);
  // typed columns appear inside the inner projection, dedup keeps first per key
  assert.match(sql, /cast\("order_id" as bigint\) as "order_id"/);
  assert.match(sql, /cast\("status" as date\) as "status"/);
  assert.match(sql, /where _dedup_rn = 1$/);
});

// ---- failure surfacing: a bad op set throws, never a silent (wrong) pass ---------

test('unknown column throws TransformError (no silent pass)', () => {
  assert.throws(() => compileSilver(spec([{ kind: 'cast', column: 'nope', type: 'double' }])), TransformError);
});

test('dropping every column throws', () => {
  assert.throws(
    () => compileSilver(spec(COLS.map((c) => ({ kind: 'drop', column: c } as TransformOp)))),
    /nothing to select/,
  );
});

test('a value carrying a SQL comment token is rejected (would fail the guard)', () => {
  assert.throws(
    () => compileSilver(spec([{ kind: 'filter', column: 'region', op: '=', value: "EU'--" }])),
    /comment/,
  );
});

test('a value carrying a statement separator is rejected', () => {
  assert.throws(
    () => compileSilver(spec([{ kind: 'filter', column: 'region', op: '=', value: 'EU; drop' }])),
    /';'/,
  );
});

test('an unsafe column name is rejected', () => {
  assert.throws(() => compileSilver(spec([], ['ok', 'bad-name'])), /invalid column name/);
});

test('two columns renamed onto the same output name is rejected', () => {
  assert.throws(
    () =>
      compileSilver(
        spec([
          { kind: 'rename', column: 'region', to: 'x' },
          { kind: 'rename', column: 'amount', to: 'x' },
        ]),
      ),
    /output as 'x'/,
  );
});

test('a non-iceberg / cross-catalog target is rejected', () => {
  assert.throws(
    () => compileSilver({ source: SRC, target: 'hive.sales.silver_returns', columns: COLS, ops: [] }),
    /iceberg\.<schema>\.<table>/,
  );
});

// ---- governance: the compiled target is ALWAYS the caller's own schema -----------

test('personalSchema matches the query-tool guard sanitization (email uid)', () => {
  assert.equal(personalSchema('alex'), 'personal_alex');
  assert.equal(personalSchema('Alex.Q@datamasterclass.com'), 'personal_alex_q_datamasterclass_com');
  assert.equal(personalSchema(''), 'personal_user');
});

test('a creator (tier dataset) always targets iceberg.personal_<uid>.silver_* — never a domain', () => {
  const plan = silverPlan(
    { name: 'Returns', domain: 'sales', tier: 'dataset' },
    { uid: 'creator', domains: ['sales'] },
    COLS,
    [{ kind: 'dedupe', keys: ['order_id'] }],
  );
  assert.equal(plan.schema, 'personal_creator');
  assert.equal(plan.target, 'iceberg.personal_creator.silver_returns');
  assert.equal(plan.source, 'iceberg.personal_creator.bronze_returns');
  assert.ok(plan.sql.includes('iceberg.personal_creator.silver_returns'));
  assert.doesNotMatch(plan.sql, /iceberg\.sales\./); // never a literal cross-domain schema
});

test('a builder on a governed asset in their own domain targets that domain schema', () => {
  const s = silverSchema({ tier: 'asset', domain: 'sales', uid: 'builder', domains: ['sales'] });
  assert.equal(s, 'sales');
  // …but if the dataset is un-promoted, still personal even for a builder
  const s2 = silverSchema({ tier: 'dataset', domain: 'sales', uid: 'builder', domains: ['sales'] });
  assert.equal(s2, 'personal_builder');
});

test('a user NOT in the target domain falls back to their personal schema (guard-safe)', () => {
  const s = silverSchema({ tier: 'asset', domain: 'finance', uid: 'outsider', domains: ['sales'] });
  assert.equal(s, 'personal_outsider'); // never someone else's domain
});

// ================================================================ Gold join =======
// The join compiler is asserted to the SAME guard shape (single, comment-free CTAS,
// caller's own iceberg schema) — dataset reuse can't smuggle a non-allowlisted write.

const BASE = 'iceberg.personal_alex.silver_returns';
const GOLD = 'iceberg.personal_alex.gold_returns';
const NP = 'iceberg.sales.gold_northpeak_commerce'; // a published asset joined by key
const KEY = [{ left: { ref: 0, column: 'order_id' }, right: 'order_id' }];

test('2-table inner join on a key + a SUM measure → correct single-statement CTAS', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: KEY }],
    dimensions: [{ col: { ref: 1, column: 'region' } }],
    measures: [{ name: 'net_revenue', agg: 'sum', col: { ref: 1, column: 'net_amount' } }],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /from iceberg\.personal_alex\.silver_returns t0 inner join iceberg\.sales\.gold_northpeak_commerce t1 on t0\."order_id" = t1\."order_id"/);
  assert.match(sql, /sum\(t1\."net_amount"\) as "net_revenue"/);
  assert.match(sql, /group by t0\."region"|group by t1\."region"$/);
});

test('left join is emitted verbatim; no measures ⇒ a plain wide join (no GROUP BY)', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'left', on: KEY }],
    dimensions: [{ col: { ref: 0, column: 'order_id' } }, { col: { ref: 1, column: 'region' } }],
    measures: [],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /left join iceberg\.sales\.gold_northpeak_commerce t1 on t0\."order_id" = t1\."order_id"/);
  assert.doesNotMatch(sql, /group by/);
});

test('a measure referencing a (masked) column still compiles — masking is read-time', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: KEY }],
    dimensions: [],
    // `email` is a typically-masked column; the compiler has no masking knowledge — the
    // Trino→OPA plugin masks it at read time when the CTAS runs as the caller.
    measures: [{ name: 'distinct_emails', agg: 'count_distinct', col: { ref: 1, column: 'email' } }],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /count\(distinct t1\."email"\) as "distinct_emails"/);
});

test('a derived measure aggregates a binary expression across the joined tables', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: KEY }],
    dimensions: [{ col: { ref: 1, column: 'region' } }],
    measures: [{ name: 'net_after_returns', agg: 'sum', left: { ref: 1, column: 'net_amount' }, op: '-', right: { ref: 0, column: 'amount' } }],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /sum\(t1\."net_amount" - t0\."amount"\) as "net_after_returns"/);
});

test('count(*) grand total (no dims) emits no GROUP BY', () => {
  const sql = compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: KEY }], dimensions: [], measures: [{ name: 'n', agg: 'count' }], target: GOLD });
  assertGuardShape(sql);
  assert.match(sql, /count\(\*\) as "n" from/);
  assert.doesNotMatch(sql, /group by/);
});

test('a three-way join keeps the table aliases aligned to the ref indices', () => {
  const OTHER = 'iceberg.sales.gold_campaigns';
  const sql = compileGoldJoin({
    source: BASE,
    joins: [
      { table: NP, type: 'inner', on: KEY },
      { table: OTHER, type: 'left', on: [{ left: { ref: 1, column: 'campaign_id' }, right: 'campaign_id' }] },
    ],
    dimensions: [{ col: { ref: 2, column: 'campaign_name' } }],
    measures: [{ name: 'spend', agg: 'sum', col: { ref: 2, column: 'cost' } }],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /inner join iceberg\.sales\.gold_northpeak_commerce t1 on t0\."order_id" = t1\."order_id"/);
  assert.match(sql, /left join iceberg\.sales\.gold_campaigns t2 on t1\."campaign_id" = t2\."campaign_id"/);
});

// ---- failure surfacing -----------------------------------------------------------

test('no joins throws (it is a JOIN builder)', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [], target: GOLD }), /at least one dataset/);
});

test('a join with no key throws', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: [] }], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [], target: GOLD }), /join key/);
});

test('a column ref to a table outside the join is rejected', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: KEY }], dimensions: [{ col: { ref: 5, column: 'x' } }], measures: [], target: GOLD }), /not part of this join/);
});

test('a join key referencing a not-yet-joined table is rejected', () => {
  assert.throws(
    () => compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: [{ left: { ref: 2, column: 'x' }, right: 'y' }] }], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [], target: GOLD }),
    /match an earlier table/,
  );
});

test('an unsafe measure name (SQL meta) is rejected', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: KEY }], dimensions: [], measures: [{ name: 'bad;drop', agg: 'count' }], target: GOLD }), /invalid measure name/);
});

test('two outputs with the same name are rejected', () => {
  assert.throws(
    () => compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: KEY }], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [{ name: 'order_id', agg: 'count' }], target: GOLD }),
    /both named 'order_id'/,
  );
});

test('a cross-catalog joined table is rejected', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [{ table: 'hive.sales.x', type: 'inner', on: KEY }], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [], target: GOLD }), /iceberg\.<schema>\.<table>/);
});

// ---- governance: the plan ALWAYS targets the caller's own schema -----------------

test("goldJoinPlan targets the caller's own personal schema, never a cross-domain one", () => {
  const plan = goldJoinPlan(
    { name: 'Returns', domain: 'sales', tier: 'dataset' },
    { uid: 'creator', domains: ['sales'] },
    [{ table: NP, type: 'inner', on: KEY }],
    [{ col: { ref: 1, column: 'region' } }],
    [{ name: 'net', agg: 'sum', col: { ref: 1, column: 'net_amount' } }],
  );
  assert.equal(plan.schema, 'personal_creator');
  assert.equal(plan.source, 'iceberg.personal_creator.silver_returns');
  assert.equal(plan.target, 'iceberg.personal_creator.gold_returns');
  assert.match(plan.sql, /^create or replace table iceberg\.personal_creator\.gold_returns as select/);
  // the join READS a cross-domain published asset (governed at read time) but never
  // WRITES outside the caller's schema.
  assert.match(plan.sql, /iceberg\.sales\.gold_northpeak_commerce/);
});

test('a builder on a governed asset writes the Gold join into their own domain schema', () => {
  const plan = goldJoinPlan(
    { name: 'Returns', domain: 'sales', tier: 'asset' },
    { uid: 'builder', domains: ['sales'] },
    [{ table: NP, type: 'inner', on: KEY }],
    [{ col: { ref: 0, column: 'order_id' } }],
    [],
  );
  assert.equal(plan.target, 'iceberg.sales.gold_returns');
});

test('goldMeasureToCube maps aggregates to a re-aggregatable Cube measure over the gold column', () => {
  assert.deepEqual(goldMeasureToCube({ name: 'net', agg: 'sum', col: { ref: 1, column: 'x' } }), { name: 'net', type: 'sum', sql: 'net' });
  assert.deepEqual(goldMeasureToCube({ name: 'n', agg: 'count' }), { name: 'n', type: 'sum', sql: 'n' });
  assert.deepEqual(goldMeasureToCube({ name: 'a', agg: 'avg', col: { ref: 0, column: 'y' } }), { name: 'a', type: 'avg', sql: 'a' });
});

// ------------------------------------------------------------- publishPlan (T8) --

test('publishPlan compiles the promote CTAS: personal source → domain target, gold preferred', () => {
  const plan = publishPlan({
    name: 'Returns Impact',
    domain: 'sales',
    owner: 'amir',
    versions: { silver: { built: true }, gold: { built: true } },
  });
  assert.equal(plan.layer, 'gold');
  assert.equal(plan.source, 'iceberg.personal_amir.gold_returns_impact');
  assert.equal(plan.sourceSchema, 'personal_amir');
  assert.equal(plan.target, 'iceberg.sales.gold_returns_impact');
  assert.equal(plan.schemaSql, 'create schema if not exists iceberg.sales');
  assert.equal(plan.sql, 'create or replace table iceberg.sales.gold_returns_impact as select * from iceberg.personal_amir.gold_returns_impact');
  // Guard shape: single statement, no comments, no ';' — /execute accepts it verbatim.
  assert.ok(!plan.sql.includes(';') && !plan.sql.includes('--') && !plan.sql.includes('/*'));
});

test('publishPlan falls back to silver when no Gold is built, and refuses bronze-only', () => {
  const silver = publishPlan({
    name: 'Orders', domain: 'sales', owner: 'amir',
    versions: { silver: { built: true }, gold: { built: false } },
  });
  assert.equal(silver.target, 'iceberg.sales.silver_orders');
  assert.throws(
    () => publishPlan({ name: 'Raw', domain: 'sales', owner: 'amir', versions: { silver: { built: false }, gold: { built: false } } }),
    TransformError,
  );
});

test('publishPlan sanitizes an email owner into the same personal schema the guard mints', () => {
  const plan = publishPlan({
    name: 'Orders', domain: 'sales', owner: 'Amir@Example.com',
    versions: { silver: { built: true }, gold: { built: true } },
  });
  assert.equal(plan.sourceSchema, 'personal_amir_example_com');
});
