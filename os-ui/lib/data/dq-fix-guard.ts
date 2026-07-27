/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * FIX-EXPRESSION GUARD — the conservative validator for LLM-proposed remediation
 * expressions (Data tab · Validate · AI-proposed fixes).
 *
 * A batch remediation is ONE scalar column-transform expression (e.g.
 * `trim(lower(email))`) that the server embeds inside a FIXED, allowlisted
 * `MERGE ... WHEN MATCHED THEN UPDATE SET col = <expr>` template. The model's raw
 * text is NEVER interpolated without passing this guard, which fails CLOSED:
 *
 *   1. single expression — no `;` (statement stacking), no SQL comments;
 *   2. no statement/clause keyword ANYWHERE (select/insert/update/delete/merge/
 *      from/where/join/union/…) — a scalar expression contains none of these, so
 *      this kills sub-SELECT smuggling outright;
 *   3. balanced parentheses + string literals;
 *   4. every identifier must be a REAL dataset column, an allowlisted Trino scalar
 *      function, an expression keyword (case/when/…), or a cast type — an unknown
 *      bare identifier (hidden column, table ref, function we didn't vet) is refused.
 *
 * The query-tool's execute_guard.py re-validates the OUTER statement shape (single
 * statement, MERGE template, schema/role gate); this guard is the INNER defence the
 * Python side cannot see because the expression body is free-form there.
 *
 * Pure + transport-free (mirrors sql-guard.ts) so both the /api routes and the MCP
 * tools import it, and it is trivially unit-tested.
 */

export type FixExprResult = { ok: true; expr: string } | { ok: false; reason: string };

/** Longest expression we accept — a real column fix is short; essays are suspect. */
export const MAX_FIX_EXPR_LENGTH = 500;

/** Trino scalar functions the fix expression may call (vetted, side-effect-free). */
export const SAFE_FIX_FUNCTIONS = [
  'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'coalesce', 'nullif', 'cast', 'try_cast',
  'replace', 'regexp_replace', 'substr', 'substring', 'concat', 'length', 'round',
  'floor', 'ceil', 'abs', 'least', 'greatest', 'date_parse', 'date_format', 'format_datetime',
  'try', 'if', 'lpad', 'rpad', 'split_part', 'position', 'strpos',
] as const;

// Expression-level keywords a scalar transform legitimately uses.
const EXPR_KEYWORDS = new Set([
  'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'is', 'null', 'in',
  'like', 'between', 'true', 'false', 'as', 'distinct', 'escape',
]);

// Cast target types (bare words; parametrized forms like varchar(20) tokenize to these).
const CAST_TYPES = new Set([
  'varchar', 'char', 'integer', 'int', 'bigint', 'smallint', 'tinyint', 'double',
  'real', 'decimal', 'boolean', 'date', 'timestamp', 'time', 'with', 'zone', 'interval',
  'day', 'month', 'year', 'hour', 'minute', 'second',
]);

// A statement/clause verb ANYWHERE means this is not a scalar expression. `with` is
// deliberately NOT here (it is part of `timestamp with time zone`); CTE smuggling is
// still dead because `select`/`from` are.
const FORBIDDEN = [
  'select', 'insert', 'update', 'delete', 'merge', 'upsert', 'drop', 'create', 'alter',
  'truncate', 'rename', 'grant', 'revoke', 'deny', 'call', 'execute', 'prepare',
  'deallocate', 'commit', 'rollback', 'union', 'intersect', 'except', 'from', 'where',
  'join', 'into', 'having', 'group', 'order', 'limit', 'values', 'using', 'on', 'set',
  'reset', 'use', 'show', 'describe', 'explain', 'table', 'over', 'partition',
];

/** Strip well-formed '…' string literals (with '' escapes) so keyword/identifier
 *  scans never trip on literal CONTENT. Returns null when a quote is unbalanced. */
function stripStringLiterals(s: string): string | null {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "'") { out += ch; i++; continue; }
    // consume a '…' literal, honouring '' escapes
    i++;
    for (;;) {
      if (i >= s.length) return null; // unterminated literal
      if (s[i] === "'") {
        if (s[i + 1] === "'") { i += 2; continue; } // escaped quote inside literal
        i++; break; // literal closed
      }
      i++;
    }
    out += " '' "; // keep token separation without the content
  }
  return out;
}

/** Extract + strip "…" quoted identifiers. Returns nulls on an unbalanced quote. */
function stripQuotedIdents(s: string): { rest: string; idents: string[] } | null {
  const idents: string[] = [];
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '"') { out += ch; i++; continue; }
    i++;
    let ident = '';
    for (;;) {
      if (i >= s.length) return null; // unterminated quoted identifier
      if (s[i] === '"') {
        if (s[i + 1] === '"') { ident += '"'; i += 2; continue; }
        i++; break;
      }
      ident += s[i];
      i++;
    }
    if (ident.length === 0) return null;
    idents.push(ident);
    out += ' _q_ '; // placeholder token (valid identifier char class, never a keyword)
  }
  return { rest: out, idents };
}

/**
 * Validate ONE proposed scalar fix expression against the dataset's real columns.
 * Fail-closed: anything not provably a plain column transform is refused with an
 * honest reason. On ok, `expr` is the trimmed expression SAFE to embed in the fixed
 * MERGE template (and ONLY there).
 */
export function validateFixExpr(raw: string, columns: string[]): FixExprResult {
  const expr = (raw ?? '').trim().replace(/;+\s*$/, '').trim();
  if (!expr) return { ok: false, reason: 'the proposed fix expression is empty' };
  if (expr.length > MAX_FIX_EXPR_LENGTH) {
    return { ok: false, reason: `the proposed expression is too long (> ${MAX_FIX_EXPR_LENGTH} chars)` };
  }
  if (expr.includes(';')) return { ok: false, reason: 'multiple statements are not allowed in a fix expression' };
  if (expr.includes('--') || expr.includes('/*') || expr.includes('*/')) {
    return { ok: false, reason: 'SQL comments are not allowed in a fix expression' };
  }

  const noLits = stripStringLiterals(expr);
  if (noLits === null) return { ok: false, reason: 'unbalanced string literal in the proposed expression' };
  const stripped = stripQuotedIdents(noLits);
  if (stripped === null) return { ok: false, reason: 'unbalanced quoted identifier in the proposed expression' };

  // Balanced parentheses (checked outside literals/quoted idents).
  let depth = 0;
  for (const ch of stripped.rest) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return { ok: false, reason: 'unbalanced parentheses in the proposed expression' }; }
  }
  if (depth !== 0) return { ok: false, reason: 'unbalanced parentheses in the proposed expression' };

  const lowered = stripped.rest.toLowerCase();
  for (const verb of FORBIDDEN) {
    if (new RegExp(`\\b${verb}\\b`).test(lowered)) {
      return { ok: false, reason: `'${verb}' is not allowed — a fix must be a single column expression, not a statement` };
    }
  }

  // Identifier allowlist: every bare word must be a column, safe function, expression
  // keyword or cast type. Quoted identifiers must be real columns.
  const colSet = new Set(columns.map((c) => c.toLowerCase()));
  const fnSet = new Set<string>(SAFE_FIX_FUNCTIONS);
  for (const q of stripped.idents) {
    if (!colSet.has(q.toLowerCase())) {
      return { ok: false, reason: `unknown column "${q}" in the proposed expression` };
    }
  }
  const words = lowered.match(/[a-z_][a-z0-9_]*/g) ?? [];
  for (const w of words) {
    if (w === '_q_') continue; // quoted-identifier placeholder, validated above
    if (colSet.has(w) || fnSet.has(w) || EXPR_KEYWORDS.has(w) || CAST_TYPES.has(w)) continue;
    return { ok: false, reason: `unknown identifier '${w}' — only the dataset's columns and vetted functions are allowed` };
  }

  return { ok: true, expr };
}

/** Guard a Trino type string (from a governed DESCRIBE) before it enters a CAST in
 *  the fixed MERGE template. DESCRIBE output is trusted-ish; this is defence-in-depth. */
export function validateSqlType(type: string): boolean {
  const t = (type ?? '').trim();
  return t.length > 0 && t.length <= 60 && /^[a-z][a-z0-9_ (),]*$/i.test(t);
}
