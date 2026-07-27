/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DataCheck } from './dataset-schema.ts';
import { DqError, quoteIdent, quoteLit, ruleLabel, violationPredicate } from './dq.ts';
import { SAFE_FIX_FUNCTIONS, validateFixExpr, validateSqlType } from './dq-fix-guard.ts';

/**
 * AI-PROPOSED DQ REMEDIATIONS — the pure core (Data tab · Validate stage).
 *
 * Everything deterministic about "propose fixes for a failing rule" lives here:
 * the proposal JSON contract, the prompt builders for the REASONING model (establish
 * the fix pattern) and the STANDARD model (fill per-row values once the pattern is
 * set — the cheap half of the split), defensive parsing of the model's reply, the
 * rows-vs-batch eligibility rules, and the governed SQL builders (fix-MERGE, preview,
 * residual count). Pure: string/value in → value/SQL out, no engine, no network — so
 * every piece is unit-tested offline (mirrors dq.ts / dq-suggest.ts).
 *
 * NON-NEGOTIABLES enforced here:
 *   - a `sqlExpr` is only ever embedded after {@link validateFixExpr} (fail-closed);
 *   - per-row proposed values are bound as ESCAPED LITERALS inside a fixed
 *     `MERGE ... USING (VALUES …)` template — never as expressions;
 *   - ROW IDENTITY IS NEVER GUESSED: rows-mode needs a column the dataset itself
 *     declares unique (a `unique` DQ rule) — otherwise rows-mode is refused with an
 *     honest reason and batch-mode is the only offer.
 */

// ------------------------------------------------------------------ contract --

/** Rows-mode ceiling: above this many failing rows only batch-mode is offered. */
export const ROWS_THRESHOLD = 200;
/** Failing rows shown to the model (the pattern sample). */
export const MODEL_SAMPLE_ROWS = 20;
/** Passing rows shown to the model for contrast. */
export const CONTRAST_SAMPLE_ROWS = 5;
/** Failing rows shown in the problems table (honest "showing N of M" above this). */
export const TABLE_SAMPLE_ROWS = 100;
/** Preview rows for the batch before→after diff. */
export const PREVIEW_ROWS = 20;

export type FixColumn = { name: string; type: string };

export type BatchProposal = {
  kind: 'batch';
  /** A single validated column-transform expression (see dq-fix-guard). */
  sqlExpr: string;
  rationale: string;
  /** MEASURED by the residual preview, never trusted from the model. */
  estimatedFix?: 'all' | 'partial';
};
export type RowFix = { pk: string; column: string; current: string; proposed: string; rationale?: string };
export type RowsProposal = { kind: 'rows'; fixes: RowFix[]; rationale?: string };
export type NoneProposal = { kind: 'none'; diagnosis: string };
export type FixProposal = BatchProposal | RowsProposal | NoneProposal;

/** Is this rule's failure fixable by transforming ONE column's values in place?
 *  `unique` (cross-row) and free-text intentions are not. */
export function columnFixable(check: DataCheck): boolean {
  return check.rule === 'not_null' || check.rule === 'not_blank' ||
    check.rule === 'accepted_values' || check.rule === 'range';
}

// -------------------------------------------------------------- row identity --

/**
 * The dataset's DECLARED row identity: a column the dataset's own DQ rules assert
 * `unique` (preferring one also asserted `not_null`), present in the physical column
 * set. NEVER inferred/guessed — no trustworthy declaration ⇒ null, and rows-mode is
 * refused honestly (batch-mode only).
 */
export function resolveRowIdentity(checks: DataCheck[], columns: string[]): string | null {
  const colSet = new Set(columns.map((c) => c.toLowerCase()));
  const uniques = checks
    .filter((c) => c.rule === 'unique' && (c.column ?? '').trim())
    .map((c) => (c.column ?? '').trim())
    .filter((c) => colSet.has(c.toLowerCase()));
  if (uniques.length === 0) return null;
  const notNull = new Set(
    checks.filter((c) => c.rule === 'not_null' && c.column).map((c) => (c.column ?? '').trim().toLowerCase()),
  );
  return uniques.find((c) => notNull.has(c.toLowerCase())) ?? uniques[0];
}

export type RowsEligibility = { ok: true; pk: string } | { ok: false; reason: string };

/** May per-row fixes be offered for this failing rule? Fail-closed with the honest
 *  reason the UI shows (including the "declare a key" hint when identity is missing). */
export function rowsEligibility(
  check: DataCheck,
  checks: DataCheck[],
  columns: string[],
  violations: number,
): RowsEligibility {
  if (!columnFixable(check)) return { ok: false, reason: 'this rule is not fixable by editing a single column' };
  const pk = resolveRowIdentity(checks, columns);
  if (!pk) {
    return {
      ok: false,
      reason: 'no declared row identity — add a unique rule on your key column to enable per-row fixes',
    };
  }
  if ((check.column ?? '').trim().toLowerCase() === pk.toLowerCase()) {
    return { ok: false, reason: 'the failing column is the key column itself — use batch mode' };
  }
  if (violations > ROWS_THRESHOLD) {
    return { ok: false, reason: `${violations} failing rows exceed the per-row limit of ${ROWS_THRESHOLD} — use batch mode` };
  }
  return { ok: true, pk };
}

// ------------------------------------------------------------------- prompts --

function ruleSpec(check: DataCheck): string {
  const parts = [`rule: ${ruleLabel(check)}`];
  if (check.description) parts.push(`description: ${check.description}`);
  return parts.join('\n');
}

function renderRows(columns: string[], rows: string[][], max: number): string {
  const take = rows.slice(0, max);
  if (take.length === 0) return '(none)';
  const head = columns.join(' | ');
  const body = take.map((r) => r.map((v) => (v === null || v === undefined ? '∅' : String(v))).join(' | '));
  return [head, ...body].join('\n');
}

export type ReasoningPromptInput = {
  datasetName: string;
  check: DataCheck;
  columns: FixColumn[];
  violations: number;
  failingColumns: string[];
  failingRows: string[][];
  passingRows: string[][];
  allowBatch: boolean;
  allowRows: boolean;
  pkColumn?: string;
};

/**
 * The REASONING-model prompt: sees the rule + schema + failing/passing samples and
 * must return ONE JSON object on the strict contract. When the rule is not
 * column-fixable only `kind:"none"` is offered (an honest diagnosis, no fake fix).
 */
export function reasoningPrompt(input: ReasoningPromptInput): { system: string; user: string } {
  const kinds: string[] = [];
  if (input.allowBatch) {
    kinds.push(
      `{"kind":"batch","sqlExpr":"<ONE Trino scalar expression over the row's columns that produces the corrected value for column '${input.check.column}'>","rationale":"<one sentence>"}`,
    );
  }
  if (input.allowRows) {
    kinds.push(
      `{"kind":"rows","rationale":"<the general pattern>","fixes":[{"pk":"<value of ${input.pkColumn}>","column":"${input.check.column}","current":"<current value>","proposed":"<corrected value>","rationale":"<short>"}]}`,
    );
  }
  kinds.push('{"kind":"none","diagnosis":"<one honest sentence: why this cannot be fixed by editing a single column, and what structural fix is needed>"}');

  const system = [
    'You are a data-quality remediation expert. A quality rule failed on a governed table.',
    'Propose the SAFEST minimal fix. Reply with EXACTLY ONE JSON object, no prose, no code fences.',
    `Allowed shapes:\n${kinds.join('\n')}`,
    input.allowBatch
      ? `sqlExpr rules: a SINGLE scalar expression, NO statements/subqueries, only these functions: ${SAFE_FIX_FUNCTIONS.join(', ')}; only the listed columns; prefer "batch" when one transform fixes the whole class.`
      : '',
    'Prefer "rows" only when values need individual judgement. If no safe column fix exists, return "none" with an honest diagnosis.',
  ].filter(Boolean).join('\n');

  const user = [
    `Dataset: ${input.datasetName}`,
    ruleSpec(input.check),
    `Failing rows: ${input.violations}`,
    `Columns: ${input.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`,
    `FAILING sample (${Math.min(input.failingRows.length, MODEL_SAMPLE_ROWS)} of ${input.violations}):`,
    renderRows(input.failingColumns, input.failingRows, MODEL_SAMPLE_ROWS),
    `PASSING sample (for contrast):`,
    renderRows(input.failingColumns, input.passingRows, CONTRAST_SAMPLE_ROWS),
  ].join('\n\n');

  return { system, user };
}

export type RowsFillPromptInput = {
  check: DataCheck;
  pkColumn: string;
  pattern: string;
  failingColumns: string[];
  failingRows: string[][];
};

/** The STANDARD-model prompt: the reasoning model set the pattern; the cheap model
 *  fills the per-row `proposed` values for the FULL failing set (≤ ROWS_THRESHOLD). */
export function rowsFillPrompt(input: RowsFillPromptInput): { system: string; user: string } {
  const system = [
    'You apply an established data-fix pattern to rows. Reply with EXACTLY ONE JSON array, no prose, no code fences.',
    `Each element: {"pk":"<value of ${input.pkColumn}>","column":"${input.check.column}","current":"<current value>","proposed":"<corrected value>"}`,
    'One element per input row, same order. If a row cannot be fixed by the pattern, set "proposed" equal to "current".',
  ].join('\n');
  const user = [
    ruleSpec(input.check),
    `Fix pattern (from the analysis step): ${input.pattern}`,
    `Rows to fix:`,
    renderRows(input.failingColumns, input.failingRows, ROWS_THRESHOLD),
  ].join('\n\n');
  return { system, user };
}

// ----------------------------------------------------------- parse the reply --

/** Fence-strip + defensive JSON.parse (the stage-route idiom). Null on garbage. */
export function parseModelJson(content: string): unknown {
  const cleaned = (content ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function coerceRowFix(v: unknown, column: string): RowFix | null {
  if (!isRecord(v)) return null;
  const pk = typeof v.pk === 'string' || typeof v.pk === 'number' ? String(v.pk) : '';
  const proposed = typeof v.proposed === 'string' || typeof v.proposed === 'number' ? String(v.proposed) : null;
  if (!pk || proposed === null) return null;
  return {
    pk,
    column, // the checked column, NEVER trusted from the model
    current: typeof v.current === 'string' || typeof v.current === 'number' ? String(v.current) : '',
    proposed,
    ...(typeof v.rationale === 'string' && v.rationale ? { rationale: v.rationale } : {}),
  };
}

/**
 * Coerce the reasoning model's reply into a typed {@link FixProposal}, honouring the
 * eligibility the SERVER decided (a "rows" reply when rows-mode is not allowed is
 * refused, never silently accepted). `sqlExpr` is validated by the fix guard here —
 * an invalid expression yields null (the caller reports it honestly).
 */
export function coerceProposal(
  parsed: unknown,
  opts: { allowBatch: boolean; allowRows: boolean; column: string; columns: string[] },
): FixProposal | null {
  if (!isRecord(parsed)) return null;
  const kind = parsed.kind;
  if (kind === 'none') {
    const diagnosis = typeof parsed.diagnosis === 'string' ? parsed.diagnosis.trim() : '';
    return diagnosis ? { kind: 'none', diagnosis } : null;
  }
  if (kind === 'batch') {
    if (!opts.allowBatch) return null;
    const checked = validateFixExpr(String(parsed.sqlExpr ?? ''), opts.columns);
    if (!checked.ok) return null;
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
    return { kind: 'batch', sqlExpr: checked.expr, rationale };
  }
  if (kind === 'rows') {
    if (!opts.allowRows) return null;
    const raw = Array.isArray(parsed.fixes) ? parsed.fixes : [];
    const fixes = raw.map((f) => coerceRowFix(f, opts.column)).filter((f): f is RowFix => f !== null);
    if (fixes.length === 0) return null;
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
    return { kind: 'rows', fixes: fixes.slice(0, ROWS_THRESHOLD), ...(rationale ? { rationale } : {}) };
  }
  return null;
}

/** Coerce the standard model's fill reply (a JSON array of row fixes). */
export function coerceRowsFill(parsed: unknown, column: string): RowFix[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((f) => coerceRowFix(f, column))
    .filter((f): f is RowFix => f !== null)
    .slice(0, ROWS_THRESHOLD);
}

// ------------------------------------------------------- governed SQL builders --

/** Guard a CAST target type; throws (fail-closed) on anything DESCRIBE never emits. */
function castRef(ref: string, type: string): string {
  if (!validateSqlType(type)) throw new DqError(`unsupported column type '${type}'`);
  return `cast(${ref} as ${type})`;
}

/**
 * The BATCH fix-MERGE: one governed statement that rewrites ONLY the rows violating
 * the rule, setting the checked column to the VALIDATED expression. Matches the
 * execute-guard MERGE shape (`MERGE INTO iceberg.<s>.<t> AS t USING … ON … WHEN …`).
 * The caller MUST pass an expression that already passed {@link validateFixExpr}.
 */
export function batchMergeSql(fqn: string, check: DataCheck, sqlExpr: string): string {
  const col = (check.column ?? '').trim();
  if (!col) throw new DqError('the check has no column');
  const pred = violationPredicate(check, `t.${quoteIdent(col)}`);
  if (pred === null) throw new DqError('this rule has no per-row violation predicate — batch fix is not possible');
  return (
    `merge into ${fqn} as t using (values (1)) as s(one) on (${pred}) ` +
    `when matched then update set ${quoteIdent(col)} = ${sqlExpr}`
  );
}

/**
 * The ROWS fix-MERGE: accepted/edited values bound as ESCAPED VARCHAR LITERALS in a
 * `USING (VALUES …)` source, matched on the DECLARED key column, cast to the real
 * column types from the governed DESCRIBE. Values are literals by construction —
 * a proposed value can never smuggle an expression.
 */
export function rowsMergeSql(
  fqn: string,
  pk: FixColumn,
  target: FixColumn,
  fixes: { pk: string; proposed: string }[],
): string {
  if (fixes.length === 0) throw new DqError('no accepted row fixes to apply');
  if (fixes.length > ROWS_THRESHOLD) throw new DqError(`too many row fixes (> ${ROWS_THRESHOLD})`);
  const rows = fixes.map((f) => `(${quoteLit(f.pk)}, ${quoteLit(f.proposed)})`).join(', ');
  return (
    `merge into ${fqn} as t using (values ${rows}) as s(k, v) ` +
    `on t.${quoteIdent(pk.name)} = ${castRef('s.k', pk.type)} ` +
    `when matched then update set ${quoteIdent(target.name)} = ${castRef('s.v', target.type)}`
  );
}

/** Read-only before→after preview of the batch expression over the failing sample. */
export function fixPreviewSql(fqn: string, check: DataCheck, sqlExpr: string, limit = PREVIEW_ROWS): string {
  const col = (check.column ?? '').trim();
  const pred = violationPredicate(check);
  if (!col || pred === null) throw new DqError('this rule has no per-row violation predicate');
  const n = Math.max(1, Math.floor(limit));
  return (
    `select cast(${quoteIdent(col)} as varchar) as current_value, ` +
    `cast(${sqlExpr} as varchar) as proposed_value from ${fqn} where ${pred} limit ${n}`
  );
}

/**
 * Read-only residual count: how many currently-failing rows would STILL violate the
 * rule after the transform. 0 ⇒ the fix is measured 'all'; > 0 ⇒ 'partial'. This is
 * how `estimatedFix` is DERIVED — measured by SQL, never trusted from the model.
 */
export function residualSql(fqn: string, check: DataCheck, sqlExpr: string): string {
  const pred = violationPredicate(check);
  const fixedPred = violationPredicate(check, '"_fixed"');
  if (pred === null || fixedPred === null) throw new DqError('this rule has no per-row violation predicate');
  return (
    `select count(*) as v from ` +
    `(select ${sqlExpr} as "_fixed" from ${fqn} where ${pred}) t where ${fixedPred}`
  );
}

// ------------------------------------------------------------- UI pure logic --

/** Per-row decision in the problems table: accept the AI value, skip, or a manual edit. */
export type RowDecision = { kind: 'accept' } | { kind: 'skip' } | { kind: 'edit'; value: string };

/** How many changes "Apply N accepted changes" would execute. */
export function acceptedCount(decisions: Record<string, RowDecision | undefined>): number {
  return Object.values(decisions).filter((d) => d && d.kind !== 'skip').length;
}

/** The literal row-fix payload the apply path receives from the table's decisions. */
export function decisionsToFixes(
  fixes: RowFix[],
  decisions: Record<string, RowDecision | undefined>,
): { pk: string; proposed: string }[] {
  const out: { pk: string; proposed: string }[] = [];
  for (const f of fixes) {
    const d = decisions[f.pk];
    if (!d || d.kind === 'skip') continue;
    out.push({ pk: f.pk, proposed: d.kind === 'edit' ? d.value : f.proposed });
  }
  return out;
}
