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
  layerTarget,
  passThroughPlan,
  resolvePassThroughSource,
  TransformError,
  type SilverSpec,
  type TransformOp,
  type GoldDerived,
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

test('builds ALWAYS run in the caller personal lane — for every tier (the workspace rule)', () => {
  // Bronze physically exists ONLY in the personal lane; routing a promoted dataset's
  // build into the domain schema was a live TABLE_NOT_FOUND. The domain copy is
  // written exclusively by the publish/re-materialize CTAS (publishPlan).
  assert.equal(silverSchema('builder'), 'personal_builder');
  assert.equal(silverSchema('creator'), 'personal_creator');
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

// ---- key adaptation ("adapt keys": mismatched keys reconciled at join time) ----

test('a same-name auto-matched key needs no adaptation (the common case is untouched)', () => {
  const sql = compileGoldJoin({ source: BASE, joins: [{ table: NP, type: 'inner', on: KEY }], dimensions: [{ col: { ref: 0, column: 'order_id' } }], measures: [], target: GOLD });
  assertGuardShape(sql);
  assert.match(sql, /on t0\."order_id" = t1\."order_id"/);
  assert.doesNotMatch(sql, /cast\(.*as .*\) = cast/);
});

test('cast adaptation coerces BOTH sides of the key to one type (varchar id vs integer id)', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: [{ left: { ref: 0, column: 'order_id' }, right: 'order_ref', adapt: { mode: 'cast', type: 'varchar' } }] }],
    dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    measures: [],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /on cast\(t0\."order_id" as varchar\) = cast\(t1\."order_ref" as varchar\)/);
});

test('text adaptation normalizes BOTH sides (case/whitespace/format) so keys line up', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: [{ left: { ref: 0, column: 'email' }, right: 'Email', adapt: { mode: 'text' } }] }],
    dimensions: [{ col: { ref: 0, column: 'email' } }],
    measures: [],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /on lower\(trim\(cast\(t0\."email" as varchar\)\)\) = lower\(trim\(cast\(t1\."Email" as varchar\)\)\)/);
});

test('an unsupported cast type in a key adaptation is rejected (no silent bad SQL)', () => {
  assert.throws(() => compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: [{ left: { ref: 0, column: 'order_id' }, right: 'order_ref', adapt: { mode: 'cast', type: 'json' as unknown as 'varchar' } }] }],
    dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    measures: [],
    target: GOLD,
  }), TransformError);
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

test('single-table Gold (0 joins) compiles a base-only projection — a join is OPTIONAL', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [],
    dimensions: [{ col: { ref: 0, column: 'region' } }],
    measures: [{ name: 'orders', agg: 'count' }, { name: 'net', agg: 'sum', col: { ref: 0, column: 'amount' } }],
    target: GOLD,
  });
  assertGuardShape(sql);
  // reads ONLY the base Silver table (no JOIN clause), aliased t0
  assert.match(sql, /from iceberg\.personal_alex\.silver_returns t0 group by t0\."region"$/);
  assert.doesNotMatch(sql, / join /);
  assert.match(sql, /count\(\*\) as "orders"/);
  assert.match(sql, /sum\(t0\."amount"\) as "net"/);
});

test('single-table Gold with dims only (no measures) is a plain base projection, no GROUP BY', () => {
  const sql = compileGoldJoin({ source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'order_id' } }, { col: { ref: 0, column: 'region' } }], measures: [], target: GOLD });
  assertGuardShape(sql);
  assert.match(sql, /from iceberg\.personal_alex\.silver_returns t0$/);
  assert.doesNotMatch(sql, /group by/);
  assert.doesNotMatch(sql, / join /);
});

test('an empty Gold spec (0 joins, no dims, no measures) is still rejected honestly', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [], dimensions: [], measures: [], target: GOLD }), /at least one column or measure/);
});

test('single-table Gold cannot reference a joined table that is not there', () => {
  assert.throws(() => compileGoldJoin({ source: BASE, joins: [], dimensions: [{ col: { ref: 1, column: 'region' } }], measures: [], target: GOLD }), /not part of this join/);
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

test('a Gold join on a governed asset STILL builds in the personal lane (publish copies to the domain)', () => {
  const plan = goldJoinPlan(
    { name: 'Returns', domain: 'sales', tier: 'asset' },
    { uid: 'builder', domains: ['sales'] },
    [{ table: NP, type: 'inner', on: KEY }],
    [{ col: { ref: 0, column: 'order_id' } }],
    [],
  );
  assert.equal(plan.target, 'iceberg.personal_builder.gold_returns');
});

test('goldJoinPlan builds a single-table Gold (0 joins) from the frozen Silver base into the frozen Gold FQN', () => {
  const plan = goldJoinPlan(
    { name: 'Returns', domain: 'sales', tier: 'dataset', slug: 'returns' },
    { uid: 'creator', domains: ['sales'] },
    [], // no join partner — a single-table Gold
    [{ col: { ref: 0, column: 'region' } }],
    [{ name: 'orders', agg: 'count' }],
  );
  assert.equal(plan.source, 'iceberg.personal_creator.silver_returns');
  assert.equal(plan.target, 'iceberg.personal_creator.gold_returns');
  assert.match(plan.sql, /^create or replace table iceberg\.personal_creator\.gold_returns as select/);
  // reads only the caller's own Silver base — no cross-table join
  assert.match(plan.sql, /from iceberg\.personal_creator\.silver_returns t0/);
  assert.doesNotMatch(plan.sql, / join /);
});

// ---- curated base: an EXPLICIT base source overrides ref 0 (the own-silver default) ----

test('goldJoinPlan with a curated baseSource reads that base as ref 0 (not the own silver)', () => {
  const BASE_TABLE = 'iceberg.sales.gold_northpeak_commerce';
  const plan = goldJoinPlan(
    { name: 'Blend', domain: 'sales', tier: 'dataset', slug: 'blend' },
    { uid: 'creator', domains: ['sales'] },
    [], // single-table compose off the explicit base
    [{ col: { ref: 0, column: 'region' } }],
    [{ name: 'orders', agg: 'count' }],
    [], // no derived
    BASE_TABLE, // the curated base
  );
  // TARGET is always the caller's own schema (composed table lands in the personal lane).
  assert.equal(plan.target, 'iceberg.personal_creator.gold_blend');
  // SOURCE (ref 0) is the explicit base, NOT the dataset's own silver_blend.
  assert.equal(plan.source, BASE_TABLE);
  assert.match(plan.sql, /from iceberg\.sales\.gold_northpeak_commerce t0/);
  assert.doesNotMatch(plan.sql, /silver_blend/);
});

test('goldJoinPlan with a curated baseSource can still JOIN in other datasets (base = ref 0)', () => {
  const BASE_TABLE = 'iceberg.sales.gold_orders';
  const plan = goldJoinPlan(
    { name: 'Blend', domain: 'sales', tier: 'dataset', slug: 'blend' },
    { uid: 'creator', domains: ['sales'] },
    [{ table: NP, type: 'inner', on: KEY }],
    [{ col: { ref: 0, column: 'order_id' } }, { col: { ref: 1, column: 'region' } }],
    [],
    [],
    BASE_TABLE,
  );
  assert.equal(plan.source, BASE_TABLE);
  assert.match(plan.sql, /from iceberg\.sales\.gold_orders t0 inner join iceberg\.sales\.gold_northpeak_commerce t1/);
});

test('goldJoinPlan rejects a non-iceberg curated baseSource (never a phantom cross-catalog read)', () => {
  assert.throws(
    () => goldJoinPlan(
      { name: 'Blend', domain: 'sales', tier: 'dataset', slug: 'blend' },
      { uid: 'creator', domains: ['sales'] },
      [], [{ col: { ref: 0, column: 'region' } }], [], [],
      'hive.sales.gold_orders', // wrong catalog
    ),
    /curated base source must be iceberg/,
  );
});

test('goldJoinPlan WITHOUT a baseSource is byte-identical to before (own-silver base default)', () => {
  const args = [
    { name: 'Returns', domain: 'sales', tier: 'dataset', slug: 'returns' },
    { uid: 'creator', domains: ['sales'] },
    [] as never[],
    [{ col: { ref: 0, column: 'region' } }],
    [{ name: 'orders', agg: 'count' as const }],
  ] as const;
  // Omitting the new arg (and passing it undefined) both resolve to the own-silver base.
  const a = goldJoinPlan(args[0], args[1], args[2], args[3], args[4]);
  const b = goldJoinPlan(args[0], args[1], args[2], args[3], args[4], [], undefined);
  assert.equal(a.source, 'iceberg.personal_creator.silver_returns');
  assert.equal(a.sql, b.sql);
});

// ---- derived fields (row-level output columns computed from joined columns) -------

test('a derived col-op-col compiles to a row-level SELECT expression aliased to its name', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: KEY }],
    dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    derived: [{ name: 'margin', left: { ref: 1, column: 'price' }, op: '-', right: { ref: 1, column: 'cost' } }],
    measures: [],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /\(t1\."price" - t1\."cost"\) as "margin"/);
  assert.doesNotMatch(sql, /group by/); // no measures ⇒ plain row-level projection
});

test('a derived col-op-constant compiles with a bare numeric literal', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [],
    dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    derived: [{ name: 'vat', left: { ref: 0, column: 'price' }, op: '*', right: { value: 0.19 } }],
    measures: [],
    target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /\(t0\."price" \* 0\.19\) as "vat"/);
});

test('derived division is null-safe: divisor wrapped in NULLIF(x, 0)', () => {
  const colDiv = compileGoldJoin({
    source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    derived: [{ name: 'unit_price', left: { ref: 0, column: 'total' }, op: '/', right: { ref: 0, column: 'qty' } }],
    measures: [], target: GOLD,
  });
  assertGuardShape(colDiv);
  assert.match(colDiv, /\(t0\."total" \/ nullif\(t0\."qty", 0\)\) as "unit_price"/);
  const constDiv = compileGoldJoin({
    source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'order_id' } }],
    derived: [{ name: 'per_two', left: { ref: 0, column: 'total' }, op: '/', right: { value: 2 } }],
    measures: [], target: GOLD,
  });
  assert.match(constDiv, /\(t0\."total" \/ nullif\(2, 0\)\) as "per_two"/);
});

test('a derived column joins the GROUP BY (alongside dims) when measures are present', () => {
  const sql = compileGoldJoin({
    source: BASE,
    joins: [{ table: NP, type: 'inner', on: KEY }],
    dimensions: [{ col: { ref: 1, column: 'region' } }],
    derived: [{ name: 'margin', left: { ref: 1, column: 'price' }, op: '-', right: { ref: 1, column: 'cost' } }],
    measures: [{ name: 'orders', agg: 'count' }],
    target: GOLD,
  });
  assertGuardShape(sql);
  // both the dimension AND the derived expression are grouping keys (row-level, not aggregated)
  assert.match(sql, /group by t1\."region", \(t1\."price" - t1\."cost"\)$/);
  assert.match(sql, /count\(\*\) as "orders"/);
});

test('a Gold with ONLY derived fields (no dims/measures) still compiles', () => {
  const sql = compileGoldJoin({
    source: BASE, joins: [], dimensions: [],
    derived: [{ name: 'margin', left: { ref: 0, column: 'price' }, op: '-', right: { ref: 0, column: 'cost' } }],
    measures: [], target: GOLD,
  });
  assertGuardShape(sql);
  assert.match(sql, /select \(t0\."price" - t0\."cost"\) as "margin" from/);
  assert.doesNotMatch(sql, /group by/);
});

test('a derived name colliding with a dimension is rejected', () => {
  assert.throws(
    () => compileGoldJoin({
      source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'margin' } }],
      derived: [{ name: 'margin', left: { ref: 0, column: 'price' }, op: '-', right: { ref: 0, column: 'cost' } }],
      measures: [], target: GOLD,
    }),
    /both named 'margin'/,
  );
});

test('a derived name colliding with a measure is rejected', () => {
  assert.throws(
    () => compileGoldJoin({
      source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'region' } }],
      derived: [{ name: 'total', left: { ref: 0, column: 'price' }, op: '+', right: { ref: 0, column: 'tax' } }],
      measures: [{ name: 'total', agg: 'sum', col: { ref: 0, column: 'amount' } }], target: GOLD,
    }),
    /both named 'total'/,
  );
});

test('an unsafe derived name (SQL meta) is rejected', () => {
  assert.throws(
    () => compileGoldJoin({
      source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'region' } }],
      derived: [{ name: 'bad;drop', left: { ref: 0, column: 'price' }, op: '-', right: { ref: 0, column: 'cost' } }],
      measures: [], target: GOLD,
    }),
    /invalid derived field name/,
  );
});

test('a derived ref to a table outside the join is rejected', () => {
  assert.throws(
    () => compileGoldJoin({
      source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'region' } }],
      derived: [{ name: 'margin', left: { ref: 3, column: 'price' }, op: '-', right: { ref: 0, column: 'cost' } }],
      measures: [], target: GOLD,
    }),
    /not part of this join/,
  );
});

test('an unsupported derived operator is rejected', () => {
  assert.throws(
    () => compileGoldJoin({
      source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'region' } }],
      derived: [{ name: 'margin', left: { ref: 0, column: 'price' }, op: '%' as unknown as '+', right: { ref: 0, column: 'cost' } }],
      measures: [], target: GOLD,
    }),
    /unsupported operator/,
  );
});

test('a non-finite derived constant (NaN/Infinity) is rejected loudly', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => compileGoldJoin({
        source: BASE, joins: [], dimensions: [{ col: { ref: 0, column: 'region' } }],
        derived: [{ name: 'x', left: { ref: 0, column: 'price' }, op: '*', right: { value: bad } }],
        measures: [], target: GOLD,
      }),
      /must be a finite number/,
    );
  }
});

test('an all-empty spec (no dims, derived or measures) is still rejected honestly', () => {
  assert.throws(
    () => compileGoldJoin({ source: BASE, joins: [], dimensions: [], derived: [], measures: [], target: GOLD }),
    /at least one column or measure/,
  );
});

test('goldJoinPlan threads derived fields through to the compiled CTAS', () => {
  const derived: GoldDerived[] = [{ name: 'margin', left: { ref: 0, column: 'price' }, op: '-', right: { ref: 0, column: 'cost' } }];
  const plan = goldJoinPlan(
    { name: 'Returns', domain: 'sales', tier: 'dataset', slug: 'returns' },
    { uid: 'creator', domains: ['sales'] },
    [], [{ col: { ref: 0, column: 'order_id' } }], [], derived,
  );
  assert.match(plan.sql, /\(t0\."price" - t0\."cost"\) as "margin"/);
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

// ------------------------------------------------ layerTarget / passThroughPlan ---

test('layerTarget always resolves to the personal-lane workspace — every tier', () => {
  const me = { uid: 'alex', domains: ['sales'] };
  assert.equal(
    layerTarget({ name: 'Web Orders', domain: 'sales', tier: 'dataset' }, me, 'silver'),
    'iceberg.personal_alex.silver_web_orders',
  );
  // A governed asset BUILDS in the personal lane too — the domain copy is written
  // only by the publish CTAS (publishPlan), never by a build.
  assert.equal(
    layerTarget({ name: 'Web Orders', domain: 'sales', tier: 'asset' }, me, 'gold'),
    'iceberg.personal_alex.gold_web_orders',
  );
});

test('passThroughPlan compiles a REAL guard-shaped CTAS copy of the prior layer (no registry-only flag)', () => {
  const me = { uid: 'alex', domains: ['sales'] };
  const silver = passThroughPlan({ name: 'Web Orders', domain: 'sales', tier: 'dataset' }, me, 'silver');
  assert.equal(silver.source, 'iceberg.personal_alex.bronze_web_orders');
  assert.equal(silver.target, 'iceberg.personal_alex.silver_web_orders');
  assert.equal(silver.sql, 'create or replace table iceberg.personal_alex.silver_web_orders as select * from iceberg.personal_alex.bronze_web_orders');
  assert.ok(!silver.sql.includes(';') && !silver.sql.includes('--'), 'guard-shaped: one statement, no comments');

  const gold = passThroughPlan({ name: 'Web Orders', domain: 'sales', tier: 'dataset' }, me, 'gold');
  assert.equal(gold.source, 'iceberg.personal_alex.silver_web_orders'); // gold copies SILVER forward
  assert.equal(gold.target, 'iceberg.personal_alex.gold_web_orders');
});

// ---------------------------------------------------- resolvePassThroughSource ---

const DS = { name: 'Northpeak Campaign Performance', domain: 'agentic-leader-q3-2026', tier: 'domain' };
const BUILDER = { uid: 'aborek', domains: ['agentic-leader-q3-2026'] };
const P = 'iceberg.personal_aborek'; // builds live in the personal-lane workspace
const G = 'iceberg.agentic_leader_q3_2026'; // the PUBLISHED domain copy (publish CTAS only)

test('pass-through copies the newest lower layer that physically exists (silver over bronze)', async () => {
  const present = new Set([`${P}.silver_northpeak_campaign_performance`, `${P}.bronze_northpeak_campaign_performance`]);
  const res = await resolvePassThroughSource(DS, BUILDER, 'gold', async (fqn) => present.has(fqn));
  assert.equal(res.kind, 'copy');
  assert.equal(res.kind === 'copy' && res.source, `${P}.silver_northpeak_campaign_performance`);
  assert.equal(res.kind === 'copy' && res.sql,
    `create or replace table ${P}.gold_northpeak_campaign_performance as select * from ${P}.silver_northpeak_campaign_performance`);
});

test('pass-through falls back to bronze when silver is absent', async () => {
  const present = new Set([`${P}.bronze_northpeak_campaign_performance`]);
  const res = await resolvePassThroughSource(DS, BUILDER, 'gold', async (fqn) => present.has(fqn));
  assert.equal(res.kind === 'copy' && res.source, `${P}.bronze_northpeak_campaign_performance`);
});

test('pass-through ADOPTS the published DOMAIN copy when it is the ONLY physical table (the seeded-gold case)', async () => {
  // A seeded governed dataset may have NO personal lane at all — only the published
  // domain gold. Adopting that copy is the honest resolution, never a raw error.
  const present = new Set([`${G}.gold_northpeak_campaign_performance`]);
  const res = await resolvePassThroughSource(DS, BUILDER, 'gold', async (fqn) => present.has(fqn));
  assert.equal(res.kind, 'adopt');
  assert.equal(res.target, `${G}.gold_northpeak_campaign_performance`);
});

test('pass-through reports NONE (never a raw Trino error) when nothing exists to carry or adopt', async () => {
  const res = await resolvePassThroughSource(DS, BUILDER, 'gold', async () => false);
  assert.equal(res.kind, 'none');
  assert.equal(res.kind === 'none' && res.tried.length, 3); // personal silver, personal bronze, domain copy
});
