/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * `evaluateFunctions` — the RUNTIME resolver for AppSpec `functions[]` (3.5d).
 *
 * It resolves each `aggregate` function by querying its GRANTED dataset via the injected governed
 * `os` client (same OPA/DLS path as every other read) and REDUCING the returned rows with a pure
 * reducer (count/sum/avg/min/max, after applying the equality/comparison filters). Then it
 * evaluates each `expression` function over the resolved values with a pure tree-walker (`expr.ts`)
 * in DAG order (topologically), detecting and REJECTING cycles (a cyclic function → `null`).
 *
 * Guarantees:
 *  • Each aggregate dataset is queried ONCE (memoized), even if several functions read it.
 *  • Every function id resolves to a stable `number | boolean | null` (never throws, never fakes):
 *      a failed query → null; a filter that removes every row → null (count → 0); a cycle → null.
 *  • Expressions see the resolved values of the functions they reference; an unknown/cyclic ref
 *      evaluates to null via the pure evaluator.
 *
 * Pure except for the `os` reads: the reducers, ordering and evaluation are all deterministic.
 */
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { evaluateExpr, parseExpr, type ExprValue } from './expr.ts';
import type { AggFilter, AggOp, AppFunction, FilterOp } from './functions-schema.ts';

export type FunctionValues = Record<string, ExprValue>;

/** Coerce a raw cell to a comparable primitive for a filter: numbers stay numbers, "true"/"false"
 *  become booleans, everything else stays a string. Blank → null (never matches a scalar). */
function cellPrimitive(raw: string | undefined): string | number | boolean | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && raw.trim() !== '') return n;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** Apply ONE filter op between a cell primitive and the filter's literal value. */
function matchOp(op: FilterOp, cell: string | number | boolean | null, value: string | number | boolean): boolean {
  if (cell === null) return false;
  switch (op) {
    case 'eq':
      return typeof cell === typeof value ? cell === value : String(cell) === String(value);
    case 'neq':
      return typeof cell === typeof value ? cell !== value : String(cell) !== String(value);
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const c = Number(cell);
      const v = Number(value);
      if (!Number.isFinite(c) || !Number.isFinite(v)) return false;
      return op === 'gt' ? c > v : op === 'lt' ? c < v : op === 'gte' ? c >= v : c <= v;
    }
  }
}

/** Keep only rows passing EVERY filter (AND semantics). Unknown filter columns drop every row. */
function applyFilters(result: QueryResult, filters: AggFilter[] | undefined): string[][] {
  const rows = result.rows ?? [];
  if (!filters || filters.length === 0) return rows;
  const idx = new Map(filters.map((f) => [f.field, result.columns.indexOf(f.field)]));
  return rows.filter((row) =>
    filters.every((f) => {
      const i = idx.get(f.field)!;
      if (i < 0) return false; // filter column not present → no row matches
      return matchOp(f.op, cellPrimitive(row[i]), f.value);
    }),
  );
}

/**
 * Reduce filtered rows to ONE number for the op. `count` → row count; sum/avg/min/max over the
 * named field's NUMERIC cells (non-numeric/blank cells ignored, never coerced). Returns null when
 * a sum/avg/min/max has no numeric cell (honest "no value"); count is always a number (0+).
 */
function reduce(rows: string[][], op: AggOp, columns: string[], field?: string): number | null {
  if (op === 'count') return rows.length;
  if (!field) return null;
  const idx = columns.indexOf(field);
  if (idx < 0) return null;
  const nums: number[] = [];
  for (const row of rows) {
    const raw = row[idx];
    if (raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return null;
  switch (op) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

/** How many dataset rows an aggregate scans. Coarse cap — matches the KPI card reader's limit. */
const AGG_QUERY_LIMIT = 5000;

/**
 * Resolve every function id to its value. Aggregates query the governed dataset (once each, cached
 * per dataset id) and reduce; expressions evaluate in DAG order with cycle rejection. NEVER throws.
 */
export async function evaluateFunctions(functions: AppFunction[], os: OsClient): Promise<FunctionValues> {
  const byId = new Map<string, AppFunction>();
  for (const fn of functions) if (!byId.has(fn.id)) byId.set(fn.id, fn); // first-wins on dup ids

  // 1) Resolve aggregates. One query per DISTINCT dataset id (memoized), shared across functions.
  const datasetCache = new Map<string, Promise<QueryResult | null>>();
  const queryDataset = (datasetId: string): Promise<QueryResult | null> => {
    let p = datasetCache.get(datasetId);
    if (!p) {
      p = os.datasets
        .query(datasetId, { limit: AGG_QUERY_LIMIT })
        .then((r) => r)
        .catch(() => null); // a failed/forbidden read → null (honest, not a throw)
      datasetCache.set(datasetId, p);
    }
    return p;
  };

  const values: FunctionValues = {};

  await Promise.all(
    functions
      .filter((fn): fn is Extract<AppFunction, { kind: 'aggregate' }> => fn.kind === 'aggregate')
      .map(async (fn) => {
        const result = await queryDataset(fn.source.datasetId);
        if (result === null) {
          values[fn.id] = null;
          return;
        }
        const rows = applyFilters(result, fn.filters);
        values[fn.id] = reduce(rows, fn.op, result.columns, fn.field);
      }),
  );

  // 2) Resolve expressions in DAG order. `visiting` marks the current DFS stack → any back-edge is
  //    a cycle (that function, and anything depending on it, resolves to null).
  const state = new Map<string, 'visiting' | 'done'>();

  const resolveExpr = (fn: Extract<AppFunction, { kind: 'expression' }>): ExprValue => {
    const parsed = parseExpr(fn.expr);
    if (!parsed.ok) return null;
    return evaluateExpr(parsed.ast, values);
  };

  const visit = (id: string): void => {
    const st = state.get(id);
    if (st === 'done') return;
    if (st === 'visiting') return; // cycle: leave as-is; the cyclic node itself is set null below
    const fn = byId.get(id);
    if (!fn || fn.kind !== 'expression') {
      // aggregates already resolved; unknown ids are simply absent (evaluator treats as null).
      state.set(id, 'done');
      return;
    }
    state.set(id, 'visiting');
    // Resolve dependencies first so this expression sees their values.
    const parsed = parseExpr(fn.expr);
    const refs = parsed.ok ? parsed.refs : [];
    let cyclic = false;
    for (const ref of refs) {
      if (state.get(ref) === 'visiting') {
        cyclic = true; // back-edge into the active stack → a cycle through `id`
        continue;
      }
      visit(ref);
    }
    values[id] = cyclic ? null : resolveExpr(fn);
    state.set(id, 'done');
  };

  for (const fn of functions) if (fn.kind === 'expression') visit(fn.id);

  return values;
}
