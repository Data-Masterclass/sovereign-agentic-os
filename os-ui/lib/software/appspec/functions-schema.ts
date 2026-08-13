/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AppSpec `functions[]` — the GOVERNED, DECLARATIVE backend DSL (Phase 3.5d). The safe, legible
 * way an app computes a table/number/flag from governed data. There is NO arbitrary code, NO
 * `eval`, ever: every function is NAMED + DESCRIBED and is exactly ONE of two safe kinds —
 *
 *  • aggregate — reduce a GRANTED dataset (queried via the governed `os` client) to ONE number:
 *      count | sum | avg | min | max, with optional equality/comparison filters. `count` needs no
 *      field; sum/avg/min/max require a numeric `field`. The reducer is pure (`functions-eval.ts`).
 *  • expression — a tiny safe grammar (`expr.ts`) over literals, references to OTHER function ids
 *      (`fn.<id>`), arithmetic, comparison, boolean and ternary. Parsed to an AST and evaluated by
 *      a pure tree-walker — never `eval`/`new Function`.
 *
 * This module is the STRUCTURAL gate: it parses an untrusted `functions` array into the closed
 * grammar and returns TYPED `{path, reason, fix}` issues (reusing schema.ts' issue machinery), so
 * the authoring agent can self-correct. Existence/grant/field/ref/cycle checks are the SEMANTIC
 * pass in `validate.ts`.
 */
import {
  bad,
  isObject,
  optString,
  reqEnum,
  reqString,
  type Ctx,
  type SpecIssue,
} from './schema.ts';
import { parseExpr } from './expr.ts';

// ---------------------------------------------------------------- enums (closed sets) --

/** The reducers an `aggregate` function may apply over its granted dataset. */
export const AGG_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggOp = (typeof AGG_OPS)[number];

/** The comparison operators a filter may use. */
export const FILTER_OPS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** The two safe function kinds. */
export const FUNCTION_KINDS = ['aggregate', 'expression'] as const;
export type FunctionKind = (typeof FUNCTION_KINDS)[number];

// --------------------------------------------------------------------- the grammar ----

/** One filter row applied to the aggregate's rows before reduction. `value` is a scalar literal. */
export type AggFilter = { field: string; op: FilterOp; value: string | number | boolean };

/** An aggregate function → a number. `count` needs no field; sum/avg/min/max require `field`. */
export type AggregateFunction = {
  id: string;
  name: string;
  description: string;
  kind: 'aggregate';
  source: { datasetId: string };
  op: AggOp;
  field?: string;
  filters?: AggFilter[];
};

/** An expression function → a number or boolean, over other function ids + literals. */
export type ExpressionFunction = {
  id: string;
  name: string;
  description: string;
  kind: 'expression';
  expr: string;
};

export type AppFunction = AggregateFunction | ExpressionFunction;

export type ParseFunctionsResult =
  | { ok: true; functions: AppFunction[] }
  | { ok: false; issues: SpecIssue[] };

// ------------------------------------------------------------------- leaf parsers -----

/** A filter value literal: a string, a finite number, or a boolean (nothing else). */
function parseFilterValue(ctx: Ctx, raw: unknown, path: string): string | number | boolean | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  bad(ctx, path, 'filter value must be a string, number, or boolean', 'set value to a scalar literal');
  return undefined;
}

function parseFilter(ctx: Ctx, raw: unknown, path: string): AggFilter | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'filter must be an object', 'use { field, op, value }');
    return undefined;
  }
  const field = reqString(ctx, raw, 'field', `${path}.field`);
  const op = reqEnum<FilterOp>(ctx, raw, 'op', FILTER_OPS, `${path}.op`);
  const hasValue = 'value' in raw;
  if (!hasValue) {
    bad(ctx, `${path}.value`, 'value is required', 'add a scalar value to compare against');
  }
  const value = hasValue ? parseFilterValue(ctx, raw.value, `${path}.value`) : undefined;
  if (field === undefined || op === undefined || value === undefined) return undefined;
  return { field, op, value };
}

function parseFilters(ctx: Ctx, raw: unknown, path: string): AggFilter[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    bad(ctx, path, 'filters must be an array', 'remove filters or set a list of { field, op, value }');
    return undefined;
  }
  const out: AggFilter[] = [];
  raw.forEach((f, i) => {
    const filter = parseFilter(ctx, f, `${path}[${i}]`);
    if (filter) out.push(filter);
  });
  return out;
}

/** Parse the `id`/`name`/`description` triple shared by both kinds. */
function parseHeader(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: string,
): { id?: string; name?: string; description?: string } {
  return {
    id: reqString(ctx, obj, 'id', `${path}.id`),
    name: reqString(ctx, obj, 'name', `${path}.name`),
    description: reqString(ctx, obj, 'description', `${path}.description`),
  };
}

function parseAggregate(
  ctx: Ctx,
  obj: Record<string, unknown>,
  header: { id: string; name: string; description: string },
  path: string,
): AggregateFunction | undefined {
  // source { datasetId }
  let datasetId: string | undefined;
  if (!isObject(obj.source)) {
    bad(ctx, `${path}.source`, 'source must be an object', 'use { datasetId }');
  } else {
    datasetId = reqString(ctx, obj.source, 'datasetId', `${path}.source.datasetId`);
  }

  const op = reqEnum<AggOp>(ctx, obj, 'op', AGG_OPS, `${path}.op`);
  const field = optString(ctx, obj, 'field', `${path}.field`);
  const filters = parseFilters(ctx, obj.filters, `${path}.filters`);

  // count needs NO field; sum/avg/min/max REQUIRE a (numeric) field.
  if (op !== undefined && op !== 'count' && field === undefined) {
    bad(ctx, `${path}.field`, `field is required for op "${op}"`, 'name the numeric field to aggregate');
  }

  if (datasetId === undefined || op === undefined) return undefined;
  if (op !== 'count' && field === undefined) return undefined;
  return {
    ...header,
    kind: 'aggregate',
    source: { datasetId },
    op,
    ...(field !== undefined ? { field } : {}),
    ...(filters !== undefined ? { filters } : {}),
  };
}

function parseExpression(
  ctx: Ctx,
  obj: Record<string, unknown>,
  header: { id: string; name: string; description: string },
  path: string,
): ExpressionFunction | undefined {
  const expr = reqString(ctx, obj, 'expr', `${path}.expr`);
  if (expr === undefined) return undefined;
  // Parse the grammar NOW (structural): a lex/parse/depth failure is a typed author-time issue.
  const parsed = parseExpr(expr);
  if (!parsed.ok) {
    bad(ctx, `${path}.expr`, `expression does not parse: ${parsed.error}`, 'fix the expression syntax');
    return undefined;
  }
  return { ...header, kind: 'expression', expr };
}

function parseFunction(ctx: Ctx, raw: unknown, path: string): AppFunction | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'function must be an object', 'use { id, name, description, kind, … }');
    return undefined;
  }
  const { id, name, description } = parseHeader(ctx, raw, path);
  const kind = reqEnum<FunctionKind>(ctx, raw, 'kind', FUNCTION_KINDS, `${path}.kind`);
  if (id === undefined || name === undefined || description === undefined || kind === undefined) {
    return undefined;
  }
  const header = { id, name, description };
  switch (kind) {
    case 'aggregate':
      return parseAggregate(ctx, raw, header, path);
    case 'expression':
      return parseExpression(ctx, raw, header, path);
    default:
      return undefined; // kind already reported
  }
}

/**
 * Parse an untrusted `functions` array into the closed grammar. OPTIONAL/additive: an absent or
 * empty array is a clean, empty result. Returns EVERY structural issue found so the caller can
 * render actionable per-field guidance. Semantic checks (grant, field-exists, ref-resolves,
 * cycles, id-uniqueness) are a SEPARATE pass in `validate.ts`.
 */
export function parseFunctions(input: unknown): ParseFunctionsResult {
  if (input === undefined) return { ok: true, functions: [] };
  const ctx: Ctx = { issues: [] };
  if (!Array.isArray(input)) {
    return { ok: false, issues: [{ path: 'functions', reason: 'functions must be an array', fix: 'set functions to a list or remove it' }] };
  }
  const functions: AppFunction[] = [];
  input.forEach((f, i) => {
    const fn = parseFunction(ctx, f, `functions[${i}]`);
    if (fn) functions.push(fn);
  });
  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };
  return { ok: true, functions };
}
