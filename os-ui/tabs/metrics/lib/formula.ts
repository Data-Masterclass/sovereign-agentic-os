/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Composite-metric formula compiler (`[profit] / [revenue]` style)
 * USER STORY: As a creator I want to define a metric as arithmetic over my other metrics, with clear
 *             errors when I write it wrong, so that I can build ratios and margins without SQL.
 * ARCHITECTURE:
 *   - Pure, tested recursive-descent parser for: expr := term (('+'|'-') term)*,
 *     term := factor (('*'|'/') factor)*, factor := number | '[' metric ']' | '(' expr ')' | '-' factor.
 *   - Compiles to the `{measure}` reference form a `number` measure already uses, so the existing SQL
 *     expansion in `./explorer.ts` serves it. `a / b` becomes `a / NULLIF(b, 0)`; the whole
 *     expression is wrapped in `1.0 *` to force double.
 *   - `assertFormulaRefs` allows only existing basic (non-`number`) siblings, one level deep. Errors
 *     are `FormulaError` (400). Used by `./model.ts` and `tabs/metrics/ui/MetricBuilder.tsx`.
 */
export class FormulaError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

export type CompiledFormula = {
  /** The compiled expression with `{measure}` references — a Cube `number` measure's sql. */
  sql: string;
  /** The distinct metric names the formula references (validation + lineage). */
  refs: string[];
};

type Token =
  | { kind: 'num'; text: string }
  | { kind: 'ref'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' };

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') {
      out.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(source.slice(i))!;
      out.push({ kind: 'num', text: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '[') {
      const end = source.indexOf(']', i);
      if (end < 0) throw new FormulaError(`Unclosed metric reference at position ${i + 1} — write it as [metric_name].`);
      const name = source.slice(i + 1, end).trim().toLowerCase();
      if (!/^[a-z0-9_]+$/.test(name)) {
        throw new FormulaError(`"[${source.slice(i + 1, end)}]" is not a metric name — use the metric's machine name (letters, digits, _), e.g. [revenue].`);
      }
      out.push({ kind: 'ref', name });
      i = end + 1;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}" at position ${i + 1} — a formula is [metric] references, numbers, + - * / and parentheses.`);
  }
  if (out.length === 0) throw new FormulaError('The formula is empty — reference at least one metric, e.g. ([revenue] - [cost]) / [orders].');
  return out;
}

/** Recursive-descent compile of the token stream (grammar above) into `{ref}` SQL. */
function parse(tokens: Token[]): CompiledFormula {
  let pos = 0;
  const refs = new Set<string>();
  const peek = () => tokens[pos];
  const isOp = (op: string): boolean => {
    const t = peek();
    return !!t && t.kind === 'op' && t.op === op;
  };

  function factor(): string {
    const t = peek();
    if (!t) throw new FormulaError('The formula ends unexpectedly — a value or [metric] is missing.');
    if (t.kind === 'num') { pos++; return t.text; }
    if (t.kind === 'ref') { pos++; refs.add(t.name); return `{${t.name}}`; }
    if (t.op === '(') {
      pos++;
      const inner = expr();
      if (!isOp(')')) throw new FormulaError('A "(" is never closed — add the matching ")".');
      pos++;
      return `(${inner})`;
    }
    if (t.op === '-') { pos++; return `-${factor()}`; }
    throw new FormulaError(`Unexpected "${t.op}" — a value or [metric] was expected there.`);
  }

  function term(): string {
    let left = factor();
    while (isOp('*') || isOp('/')) {
      const op = (peek() as { op: '*' | '/' }).op;
      pos++;
      const right = factor();
      // Null-safe division (DAX DIVIDE): zero denominator → NULL, never an error.
      left = op === '/' ? `${left} / NULLIF(${right}, 0)` : `${left} * ${right}`;
    }
    return left;
  }

  function expr(): string {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = (peek() as { op: '+' | '-' }).op;
      pos++;
      left = `${left} ${op} ${term()}`;
    }
    return left;
  }

  const sql = expr();
  if (pos < tokens.length) {
    const t = tokens[pos];
    const what = t.kind === 'op' ? `"${t.op}"` : t.kind === 'ref' ? `[${t.name}]` : `"${t.text}"`;
    throw new FormulaError(`Unexpected ${what} after the end of the formula — check for a missing operator.`);
  }
  if (refs.size === 0) throw new FormulaError('The formula references no metric — a composite metric must use at least one [metric].');
  // 1.0 * forces double so integer counts divide correctly (5/2 = 2.5, not 2).
  return { sql: `1.0 * (${sql})`, refs: [...refs] };
}

/** Compile a formula source into its `{measure}`-reference SQL + the referenced names. */
export function compileFormula(source: string): CompiledFormula {
  return parse(tokenize(source));
}

/**
 * Validate a compiled formula's references against the dataset's existing measures:
 * every ref must exist and be a BASIC metric (not itself a formula/ratio) — the SQL
 * expansion is deliberately one level deep, exactly like the guided ratio.
 */
export function assertFormulaRefs(refs: string[], siblings: { name: string; type: string }[]): void {
  for (const ref of refs) {
    const sib = siblings.find((s) => s.name === ref);
    if (!sib) {
      const have = siblings.map((s) => `[${s.name}]`).join(', ') || 'none yet';
      throw new FormulaError(`The formula references [${ref}], but this dataset has no such metric (available: ${have}). Define it first.`);
    }
    if (sib.type === 'number') {
      throw new FormulaError(`[${ref}] is itself a formula/ratio — a composite metric may only reference BASIC metrics (sum, count, avg, …), so reference its parts instead.`);
    }
  }
}
