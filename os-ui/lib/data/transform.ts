/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Silver transform COMPILER (Data tab, stage 3). Guided cleaning ops → ONE
 * governed `CREATE OR REPLACE TABLE … AS SELECT` statement that the query-tool
 * `/execute` allowlist accepts verbatim. Pure + self-contained (no server / network
 * imports) so it compiles the same SQL in the browser preview ("Show the code") and
 * on the server before it is executed — and is fully unit-testable.
 *
 * The output is deliberately SHAPED to pass `images/query-tool/execute_guard.py`:
 *   - exactly one statement (no trailing ';', no embedded ';'),
 *   - NO SQL comments (line or block) anywhere — the guard rejects them outright,
 *   - target is `iceberg.<schema>.<table>` with bare lowercase identifiers,
 *   - the target schema is the CALLER's own domain or `personal_<uid>` schema (see
 *     {@link silverSchema} / {@link personalSchema}) — never a literal cross-domain
 *     schema, so the guard's target-authorization floor always holds for the caller.
 * The CTAS runs AS the caller, so Trino→OPA masks the reads inside the SELECT: a
 * build can only read what the builder may read. This module never bypasses that —
 * it only assembles a safe statement; the query-tool re-validates it.
 */

import type { Measure } from './dataset-schema.ts';

export class TransformError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TransformError';
    this.status = status;
  }
}

/** The cast targets the guided "set the type" control offers (Trino types). */
export const CAST_TYPES = ['varchar', 'integer', 'bigint', 'double', 'boolean', 'date', 'timestamp'] as const;
export type CastType = (typeof CAST_TYPES)[number];

/** Comparison + presence predicates the guided "keep rows where" control offers. */
export const FILTER_OPS = ['=', '<>', '>', '>=', '<', '<=', 'not_null', 'not_blank'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** One guided cleaning operation. Ops reference SOURCE column names; `rename` only
 *  changes the output alias, so casts/cleans compose on the original column. */
export type TransformOp =
  | { kind: 'rename'; column: string; to: string }
  | { kind: 'cast'; column: string; type: CastType }
  | { kind: 'trim'; column: string }
  | { kind: 'normalize'; column: string } // lower(trim(x))
  | { kind: 'drop'; column: string }
  | { kind: 'filter'; column: string; op: FilterOp; value?: string }
  | { kind: 'dedupe'; keys: string[] }; // empty keys ⇒ SELECT DISTINCT

export type SilverSpec = {
  /** Fully-qualified Bronze source: `iceberg.<schema>.bronze_<slug>`. */
  source: string;
  /** Fully-qualified Silver target: `iceberg.<schema>.silver_<slug>` (caller schema). */
  target: string;
  /** Ordered SOURCE column names the projection starts from. */
  columns: string[];
  ops: TransformOp[];
};

// --------------------------------------------------------------- guard-shape lint

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FQN = /^iceberg\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const RN = '_dedup_rn'; // internal row-number alias (kept out of the projection)

/** No comment tokens and no statement separator — the two things the guard rejects
 *  outright, so we reject them at compile time and surface a clear reason instead. */
function assertNoSqlMeta(s: string, what: string): void {
  if (s.includes('--') || s.includes('/*') || s.includes('*/')) {
    throw new TransformError(`${what} may not contain SQL comments`);
  }
  if (s.includes(';')) throw new TransformError(`${what} may not contain ';'`);
}

/** Quote a column identifier (double-quotes) after validating it is a bare name. */
function qcol(id: string): string {
  if (!IDENT.test(id)) {
    throw new TransformError(
      `invalid column name '${id}' — use letters, digits and underscores (start with a letter or underscore)`,
    );
  }
  return `"${id}"`;
}

function assertFqn(f: string, what: string): void {
  if (!FQN.test(f)) {
    throw new TransformError(`${what} must be iceberg.<schema>.<table> in lowercase — got '${f}'`);
  }
}

/** A SQL literal for a filter value: bare number, else a single-quoted string with
 *  quotes doubled. Comment/`;` tokens are rejected (they'd fail the guard). */
function literal(v: string): string {
  assertNoSqlMeta(v, 'filter value');
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

// -------------------------------------------------------------------- compiler ---

/**
 * Compile guided ops into ONE guard-passing CTAS. Throws {@link TransformError} on
 * any invalid op (unknown column, empty projection, bad type/op) so a bad op set
 * surfaces an error — never a silently-wrong statement.
 */
export function compileSilver(spec: SilverSpec): string {
  assertFqn(spec.source, 'source');
  assertFqn(spec.target, 'target');
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    throw new TransformError('no source columns to transform');
  }

  const seen = new Set<string>();
  for (const c of spec.columns) {
    qcol(c);
    if (seen.has(c)) throw new TransformError(`duplicate source column '${c}'`);
    seen.add(c);
  }

  // Working projection, one entry per source column (order preserved).
  const cols = spec.columns.map((c) => ({ src: c, expr: qcol(c), alias: c, dropped: false }));
  const find = (name: string) => {
    const col = cols.find((x) => x.src === name);
    if (!col) throw new TransformError(`op references unknown column '${name}'`);
    return col;
  };

  const wheres: string[] = [];
  let dedupe: { keys: string[]; distinct: boolean } | null = null;

  for (const op of spec.ops) {
    switch (op.kind) {
      case 'drop':
        find(op.column).dropped = true;
        break;
      case 'rename': {
        if (!IDENT.test(op.to)) throw new TransformError(`invalid new name '${op.to}' for '${op.column}'`);
        find(op.column).alias = op.to;
        break;
      }
      case 'cast': {
        if (!CAST_TYPES.includes(op.type)) throw new TransformError(`unsupported type '${op.type}'`);
        const col = find(op.column);
        col.expr = `cast(${col.expr} as ${op.type})`;
        break;
      }
      case 'trim': {
        const col = find(op.column);
        col.expr = `trim(${col.expr})`;
        break;
      }
      case 'normalize': {
        const col = find(op.column);
        col.expr = `lower(trim(${col.expr}))`;
        break;
      }
      case 'filter': {
        const c = qcol(op.column);
        find(op.column); // must exist
        if (op.op === 'not_null') {
          wheres.push(`${c} is not null`);
        } else if (op.op === 'not_blank') {
          wheres.push(`${c} is not null and trim(cast(${c} as varchar)) <> ''`);
        } else {
          if (!FILTER_OPS.includes(op.op)) throw new TransformError(`unsupported filter '${op.op}'`);
          wheres.push(`${c} ${op.op} ${literal(op.value ?? '')}`);
        }
        break;
      }
      case 'dedupe': {
        const keys = Array.isArray(op.keys) ? op.keys : [];
        keys.forEach((k) => find(k)); // keys must be real source columns
        dedupe = { keys, distinct: keys.length === 0 };
        break;
      }
      default:
        throw new TransformError(`unknown op '${(op as { kind?: string }).kind}'`);
    }
  }

  const projected = cols.filter((c) => !c.dropped);
  if (projected.length === 0) throw new TransformError('every column was dropped — nothing to select');
  const aliasSeen = new Set<string>();
  for (const c of projected) {
    if (aliasSeen.has(c.alias)) throw new TransformError(`two columns both output as '${c.alias}'`);
    aliasSeen.add(c.alias);
  }

  const projSql = projected
    .map((c) => (c.expr === qcol(c.src) && c.alias === c.src ? qcol(c.src) : `${c.expr} as ${qcol(c.alias)}`))
    .join(', ');
  const whereSql = wheres.length ? ` where ${wheres.join(' and ')}` : '';

  let body: string;
  if (dedupe && !dedupe.distinct) {
    const keys = dedupe.keys.map(qcol).join(', ');
    const inner = `select ${projSql}, row_number() over (partition by ${keys} order by ${keys}) as ${RN} from ${spec.source}${whereSql}`;
    const outer = projected.map((c) => qcol(c.alias)).join(', ');
    body = `select ${outer} from (${inner}) where ${RN} = 1`;
  } else if (dedupe) {
    body = `select distinct ${projSql} from ${spec.source}${whereSql}`;
  } else {
    body = `select ${projSql} from ${spec.source}${whereSql}`;
  }

  const sql = `create or replace table ${spec.target} as ${body}`;
  assertNoSqlMeta(sql, 'compiled SQL'); // defense in depth: never emit a guard-failing statement
  return sql;
}

// --------------------------------------------------------------- FQN / schema ----

/** A stable, guard-compatible slug (lowercase bare identifier). Mirrors store-fqn. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/** The caller's private sandbox schema. MUST match the query-tool guard's
 *  `personal_schema(uid)` exactly, so the compiled target passes its authorization. */
export function personalSchema(uid: string): string {
  const core = (uid ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return 'personal_' + (core || 'user');
}

/** A domain normalized to a VALID Trino/Iceberg schema identifier — the SAME shape as
 *  store-fqn.domainSchema, so a hyphenated domain (`agentic-leader-q3-2026`) becomes a
 *  legal schema (`agentic_leader_q3_2026`) instead of a SYNTAX_ERROR. */
export function domainSchema(domain: string): string {
  const core = (domain ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return core || 'domain';
}

/**
 * The schema a Silver build writes into: the dataset's own domain when the dataset is
 * already governed AND the caller is in that domain (the query-tool re-checks the
 * builder role floor); otherwise the caller's personal sandbox schema. This is the
 * ONE place the Silver write-target is chosen — it is always the CALLER's schema,
 * never a literal cross-domain schema.
 */
export function silverSchema(o: { tier: string; domain: string; uid: string; domains: string[] }): string {
  if (o.tier !== 'dataset' && Array.isArray(o.domains) && o.domains.includes(o.domain)) return domainSchema(o.domain);
  return personalSchema(o.uid);
}

// ================================================================ Gold join =====
/**
 * The Gold JOIN COMPILER (Data tab, stage 4 — dataset REUSE). Picks 1..n ADDITIONAL
 * datasets the caller may read and joins them to the caller's own Silver base on
 * chosen keys, projecting joined dimensions + derived business measures
 * (SUM/AVG/COUNT/…/expressions) into ONE guard-passing
 * `CREATE OR REPLACE TABLE iceberg.<caller-schema>.gold_<slug> AS SELECT …`.
 *
 * Same discipline as {@link compileSilver}: single statement, no comments, no ';',
 * bare lowercase iceberg FQNs, target = the CALLER's own schema. The CTAS runs AS the
 * caller, so Trino→OPA masks the reads of EVERY joined table — the join can only read
 * what the builder may read (a masked column still compiles here; masking is enforced
 * at read time, not compile time). This module only assembles a safe statement; the
 * query-tool `/execute` guard re-validates it.
 */

export const JOIN_TYPES = ['inner', 'left'] as const;
export type JoinType = (typeof JOIN_TYPES)[number];

export const MEASURE_AGGS = ['sum', 'avg', 'count', 'count_distinct', 'min', 'max'] as const;
export type MeasureAgg = (typeof MEASURE_AGGS)[number];

export const MEASURE_OPS = ['+', '-', '*', '/'] as const;
export type MeasureOp = (typeof MEASURE_OPS)[number];

/** A column drawn from one join input: `ref` 0 = the base source, 1..n = joins[ref-1]. */
export type ColRef = { ref: number; column: string };

/** One equi-key of a join: an earlier table's column = a column on THIS joined table. */
export type JoinCond = { left: ColRef; right: string };

export type JoinInput = { table: string; type: JoinType; on: JoinCond[] };

/** A projected dimension (grouped when measures are present). */
export type GoldDimension = { col: ColRef; as?: string };

/** A business measure: count(*), an aggregate of a column, or an aggregate of a
 *  binary expression of two qualified columns (e.g. `sum(revenue - returned)`). */
export type GoldMeasure =
  | { name: string; agg: 'count' }
  | { name: string; agg: MeasureAgg; col: ColRef }
  | { name: string; agg: MeasureAgg; left: ColRef; op: MeasureOp; right: ColRef };

export type GoldJoinSpec = {
  /** The caller's Silver base — `iceberg.<caller-schema>.silver_<slug>` (alias `t0`). */
  source: string;
  /** 1..n additional visible tables to join (aliased `t1`..`tn`). */
  joins: JoinInput[];
  /** Projected columns (the joined shape). */
  dimensions: GoldDimension[];
  /** Derived measures. When present, the query GROUPs BY the dimensions. */
  measures: GoldMeasure[];
  /** The caller's Gold target — `iceberg.<caller-schema>.gold_<slug>`. */
  target: string;
};

function tableAlias(ref: number): string {
  return `t${ref}`;
}

/** `t{ref}."col"` — a qualified, validated column expression bound to a join input. */
function qref(c: ColRef, maxRef: number, what: string): string {
  if (!c || !Number.isInteger(c.ref) || c.ref < 0 || c.ref > maxRef) {
    throw new TransformError(`${what} references a table that is not part of this join`);
  }
  return `${tableAlias(c.ref)}.${qcol(c.column)}`;
}

function measureExpr(m: GoldMeasure, maxRef: number): string {
  if (!m || typeof m.name !== 'string') throw new TransformError('a measure needs a name');
  if (!IDENT.test(m.name)) throw new TransformError(`invalid measure name '${m.name}'`);
  // count(*) — the one measure with no column.
  if (m.agg === 'count' && !('col' in m) && !('left' in m)) return 'count(*)';
  if (!MEASURE_AGGS.includes(m.agg)) throw new TransformError(`measure '${m.name}': unsupported aggregation '${m.agg}'`);
  let inner: string;
  if ('col' in m) {
    inner = qref(m.col, maxRef, `measure '${m.name}'`);
  } else if ('left' in m) {
    if (!MEASURE_OPS.includes(m.op)) throw new TransformError(`measure '${m.name}': unsupported operator '${m.op}'`);
    const l = qref(m.left, maxRef, `measure '${m.name}'`);
    const r = qref(m.right, maxRef, `measure '${m.name}'`);
    inner = `${l} ${m.op} ${r}`;
  } else {
    // Unreachable by the types (a count(*) measure returned above); guard anyway.
    throw new TransformError('measure is malformed');
  }
  return m.agg === 'count_distinct' ? `count(distinct ${inner})` : `${m.agg}(${inner})`;
}

/**
 * Compile a join spec into ONE guard-passing CTAS. Throws {@link TransformError} on any
 * invalid input (bad FQN/column, unknown table ref, no join key, duplicate output) so a
 * bad spec surfaces a clear reason — never a silently-wrong statement.
 */
export function compileGoldJoin(spec: GoldJoinSpec): string {
  assertFqn(spec.source, 'source');
  assertFqn(spec.target, 'target');
  const joins = Array.isArray(spec.joins) ? spec.joins : [];
  if (joins.length === 0) throw new TransformError('add at least one dataset to join');
  const maxRef = joins.length; // base = 0 … joins[n-1] = n

  const joinSql: string[] = [];
  const tableSeen = new Set<string>([spec.source]);
  joins.forEach((j, i) => {
    assertFqn(j.table, `join #${i + 1} table`);
    if (tableSeen.has(j.table)) throw new TransformError(`${j.table} is joined more than once`);
    tableSeen.add(j.table);
    if (!JOIN_TYPES.includes(j.type)) throw new TransformError(`join #${i + 1} type must be inner or left`);
    const conds = Array.isArray(j.on) ? j.on : [];
    if (conds.length === 0) throw new TransformError(`choose a join key for ${j.table}`);
    const rightAlias = tableAlias(i + 1);
    const on = conds.map((c) => {
      // The left side must reference an ALREADY-joined table (base or an earlier join).
      if (!c || !c.left || c.left.ref > i) throw new TransformError(`the join key for ${j.table} must match an earlier table`);
      const left = qref(c.left, i, `join #${i + 1} key`);
      return `${left} = ${rightAlias}.${qcol(c.right)}`;
    });
    joinSql.push(`${j.type} join ${j.table} ${rightAlias} on ${on.join(' and ')}`);
  });

  const dims = Array.isArray(spec.dimensions) ? spec.dimensions : [];
  const measures = Array.isArray(spec.measures) ? spec.measures : [];
  if (dims.length === 0 && measures.length === 0) {
    throw new TransformError('pick at least one column or measure for the Gold table');
  }

  const outNames = new Set<string>();
  const claim = (name: string) => {
    if (!IDENT.test(name)) throw new TransformError(`invalid output name '${name}'`);
    if (outNames.has(name)) throw new TransformError(`two outputs both named '${name}'`);
    outNames.add(name);
  };

  const dimExprs: string[] = [];
  const dimSelect = dims.map((d) => {
    const expr = qref(d.col, maxRef, 'dimension');
    const out = d.as && d.as.trim() ? d.as.trim() : d.col.column;
    claim(out);
    dimExprs.push(expr);
    return `${expr} as ${qcol(out)}`;
  });

  const measureSelect = measures.map((m) => {
    const expr = measureExpr(m, maxRef);
    claim(m.name);
    return `${expr} as ${qcol(m.name)}`;
  });

  const selectList = [...dimSelect, ...measureSelect].join(', ');
  // Aggregating measures require a GROUP BY of the (non-aggregated) dimensions; an
  // all-measure spec (no dims) is a single grand-total row.
  const groupBy = measures.length > 0 && dimExprs.length > 0 ? ` group by ${dimExprs.join(', ')}` : '';
  const body = `select ${selectList} from ${spec.source} ${tableAlias(0)} ${joinSql.join(' ')}${groupBy}`;
  const sql = `create or replace table ${spec.target} as ${body}`;
  assertNoSqlMeta(sql, 'compiled SQL'); // defense in depth: never emit a guard-failing statement
  return sql;
}

/**
 * Map a compiled {@link GoldMeasure} to the Cube {@link Measure} recorded in
 * `dataset.yaml` (feeds `scaffoldCubeYaml` in T7). The Gold CTAS pre-aggregates each
 * measure into a column named `m.name`; Cube re-aggregates THAT column. sum/min/max
 * re-aggregate exactly; count(_distinct) become a `sum` of partial counts; avg is
 * approximate over pre-aggregated groups (documented — no faked exactness).
 */
export function goldMeasureToCube(m: GoldMeasure): Measure {
  const type = m.agg === 'count' || m.agg === 'count_distinct' ? 'sum' : m.agg;
  return { name: m.name, type, sql: m.name };
}

export type SilverPlan = { source: string; target: string; schema: string; sql: string };

/**
 * Resolve the source/target FQNs from the dataset + caller identity and compile the
 * CTAS. Server-authoritative: the route calls this (never trusts a client-sent SQL).
 */
export function silverPlan(
  dataset: { name: string; domain: string; tier: string },
  identity: { uid: string; domains: string[] },
  columns: string[],
  ops: TransformOp[],
): SilverPlan {
  const schema = silverSchema({ tier: dataset.tier, domain: dataset.domain, uid: identity.uid, domains: identity.domains });
  const s = slug(dataset.name);
  const source = `iceberg.${schema}.bronze_${s}`;
  const target = `iceberg.${schema}.silver_${s}`;
  const sql = compileSilver({ source, target, columns, ops });
  return { source, target, schema, sql };
}

// ================================================================ Publish =======

export type PublishPlan = {
  /** The requester's built personal-lane table the publish copies FROM. */
  source: string;
  /** The personal schema holding {@link source} — the one-time read-release subject. */
  sourceSchema: string;
  /** The governed target — `iceberg.<domain>.<layer>_<slug>` (== `assetTarget`). */
  target: string;
  layer: 'gold' | 'silver';
  /** `CREATE SCHEMA IF NOT EXISTS iceberg.<domain>` — run first (idempotent). */
  schemaSql: string;
  /** The single allowlisted promote CTAS (guard-shaped, one statement, no comments). */
  sql: string;
};

/**
 * Compile the PHYSICAL PUBLISH for an approved promotion (T8): copy the requester's
 * built Gold (or Silver) table out of their personal lane into the governed domain
 * schema with ONE allowlisted `CREATE OR REPLACE TABLE … AS SELECT`. Server-
 * authoritative and pure — the approval effect calls this; nothing is client-sent.
 *
 * Identity contract (separation of duties): the returned statements are executed as
 * the APPROVING Builder — never the requester — via the governed `/execute` path.
 * The read of `iceberg.personal_<owner>.…` inside the CTAS is only possible through
 * the one-time, read-only promotion release on `sourceSchema` (trino.rego
 * `data.governance.releases`), pushed just before and withdrawn right after.
 */
export function publishPlan(d: {
  name: string;
  domain: string;
  owner: string;
  versions: { silver: { built: boolean }; gold: { built: boolean } };
}): PublishPlan {
  const layer = d.versions.gold.built ? 'gold' : d.versions.silver.built ? 'silver' : null;
  if (!layer) throw new TransformError('nothing to publish — build a Silver or Gold version first');
  const s = slug(d.name);
  const sourceSchema = personalSchema(d.owner);
  const source = `iceberg.${sourceSchema}.${layer}_${s}`;
  const target = `iceberg.${domainSchema(d.domain)}.${layer}_${s}`;
  assertFqn(source, 'publish source');
  assertFqn(target, 'publish target');
  const schemaSql = `create schema if not exists iceberg.${domainSchema(d.domain)}`;
  const sql = `create or replace table ${target} as select * from ${source}`;
  assertNoSqlMeta(sql, 'compiled SQL'); // defense in depth: never emit a guard-failing statement
  return { source, sourceSchema, target, layer, schemaSql, sql };
}

/** One picked join, resolved SERVER-SIDE: the route turns each picked datasetId into
 *  its physical FQN (via the canView-scoped store) — the client never sends a table
 *  name, so a join can only target a table the caller may actually read. */
export type ResolvedJoin = { table: string; type: JoinType; on: JoinCond[] };

export type GoldJoinPlan = { source: string; target: string; schema: string; sql: string };

/**
 * Resolve the caller's Silver base + Gold target FQNs and compile the join CTAS.
 * Server-authoritative (the route calls this, never a client-sent SQL): the target is
 * ALWAYS the caller's own schema — never a literal cross-domain schema — exactly like
 * {@link silverPlan}. The joined tables come pre-resolved (visible to the caller).
 */
export function goldJoinPlan(
  dataset: { name: string; domain: string; tier: string },
  identity: { uid: string; domains: string[] },
  joins: ResolvedJoin[],
  dimensions: GoldDimension[],
  measures: GoldMeasure[],
): GoldJoinPlan {
  const schema = silverSchema({ tier: dataset.tier, domain: dataset.domain, uid: identity.uid, domains: identity.domains });
  const s = slug(dataset.name);
  const source = `iceberg.${schema}.silver_${s}`;
  const target = `iceberg.${schema}.gold_${s}`;
  const sql = compileGoldJoin({ source, joins, dimensions, measures, target });
  return { source, target, schema, sql };
}
