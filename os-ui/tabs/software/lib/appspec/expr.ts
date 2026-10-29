/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * A TINY, SAFE expression grammar for AppSpec `functions[]` (kind:'expression').
 *
 * The whole point is legibility + safety-by-construction: an expression is parsed into a small
 * closed AST and evaluated by a PURE tree-walker. There is NO `eval`, NO `new Function`, NO
 * property access, NO calls, NO globals — the only "identifiers" are references to OTHER function
 * ids written `fn.<id>`, resolved from an injected value map. An unknown ref, a division by zero,
 * or a type error evaluates to `null` (honest "no value"), never a throw or a fabricated number.
 *
 * Grammar (lowest → highest precedence):
 *   ternary   := logicalOr ('?' ternary ':' ternary)?
 *   logicalOr := logicalAnd ('||' logicalAnd)*
 *   logicalAnd:= equality ('&&' equality)*
 *   equality  := comparison (('=='|'!=') comparison)*
 *   comparison:= additive (('<'|'>'|'<='|'>=') additive)*
 *   additive  := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/') unary)*
 *   unary     := ('!'|'-') unary | primary
 *   primary   := number | string | 'true' | 'false' | 'fn' '.' ident | '(' ternary ')'
 *
 * `parseExpr` returns `{ ok, ast, refs }` or `{ ok:false, error }` (a typed author-time issue).
 * `evaluateExpr(ast, values)` returns `number | boolean | null` purely.
 *
 * DEPTH CAP: parse rejects an expression whose AST nests deeper than `MAX_DEPTH`, so a
 * pathological input can never blow the evaluator's stack. The evaluator ALSO carries its own
 * depth guard (belt-and-braces) and returns null past the cap.
 */

/** Max AST nesting depth. A real KPI expression is shallow; this stops adversarial nesting. */
export const MAX_DEPTH = 64;
/** Max token count — a coarse complexity cap so a giant flat expression can't churn. */
export const MAX_TOKENS = 512;

// ------------------------------------------------------------------------------- AST --

export type BinOp = '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||';
export type UnOp = '!' | '-';

export type ExprNode =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'ref'; id: string } // fn.<id>
  | { type: 'unary'; op: UnOp; arg: ExprNode }
  | { type: 'binary'; op: BinOp; left: ExprNode; right: ExprNode }
  | { type: 'ternary'; cond: ExprNode; then: ExprNode; else: ExprNode };

// ---------------------------------------------------------------------------- tokens --

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ident'; v: string }
  | { k: 'punct'; v: string };

const PUNCT_2 = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const PUNCT_1 = new Set(['+', '-', '*', '/', '<', '>', '!', '?', ':', '(', ')', '.']);

/** Tokenize an expression string. Returns tokens or a typed error (bad character / unterminated). */
function tokenize(src: string): { ok: true; tokens: Tok[] } | { ok: false; error: string } {
  const tokens: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    // string literal ("…" or '…'), no escapes needed for KPI labels but we honor \" and \\.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          out += src[j + 1];
          j += 2;
          continue;
        }
        out += src[j];
        j += 1;
      }
      if (j >= n) return { ok: false, error: 'unterminated string literal' };
      tokens.push({ k: 'str', v: out });
      i = j + 1;
      continue;
    }
    // number (integer or decimal; no exponents needed for KPIs)
    if (c >= '0' && c <= '9') {
      let j = i;
      let seenDot = false;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || (src[j] === '.' && !seenDot))) {
        if (src[j] === '.') seenDot = true;
        j += 1;
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v)) return { ok: false, error: `invalid number "${text}"` };
      tokens.push({ k: 'num', v });
      i = j;
      continue;
    }
    // identifier (letters, digits, underscore, hyphen — matches function-id shape after `fn.`)
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_-]/.test(src[j])) j += 1;
      tokens.push({ k: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // 2-char then 1-char punctuation
    const two = src.slice(i, i + 2);
    if (PUNCT_2.has(two)) {
      tokens.push({ k: 'punct', v: two });
      i += 2;
      continue;
    }
    if (PUNCT_1.has(c)) {
      tokens.push({ k: 'punct', v: c });
      i += 1;
      continue;
    }
    return { ok: false, error: `unexpected character "${c}"` };
  }
  if (tokens.length > MAX_TOKENS) return { ok: false, error: `expression too long (${tokens.length} tokens, max ${MAX_TOKENS})` };
  return { ok: true, tokens };
}

// ---------------------------------------------------------------------------- parser --

export type ParseExprResult =
  | { ok: true; ast: ExprNode; refs: string[] }
  | { ok: false; error: string };

class ParseError extends Error {}

/** A recursive-descent parser producing the closed AST above. Tracks max depth to enforce the cap. */
function parse(tokens: Tok[]): { ast: ExprNode; refs: string[] } {
  let pos = 0;
  const refs = new Set<string>();

  const peek = (): Tok | undefined => tokens[pos];
  const next = (): Tok | undefined => tokens[pos++];
  const isPunct = (v: string): boolean => {
    const t = peek();
    return !!t && t.k === 'punct' && t.v === v;
  };
  const eat = (v: string): void => {
    if (!isPunct(v)) throw new ParseError(`expected "${v}"`);
    pos += 1;
  };

  function guard(depth: number): void {
    if (depth > MAX_DEPTH) throw new ParseError(`expression nests too deep (max ${MAX_DEPTH})`);
  }

  function ternary(depth: number): ExprNode {
    guard(depth);
    const cond = logicalOr(depth + 1);
    if (isPunct('?')) {
      eat('?');
      const then = ternary(depth + 1);
      eat(':');
      const els = ternary(depth + 1);
      return { type: 'ternary', cond, then, else: els };
    }
    return cond;
  }

  function logicalOr(depth: number): ExprNode {
    guard(depth);
    let left = logicalAnd(depth + 1);
    while (isPunct('||')) {
      eat('||');
      left = { type: 'binary', op: '||', left, right: logicalAnd(depth + 1) };
    }
    return left;
  }

  function logicalAnd(depth: number): ExprNode {
    guard(depth);
    let left = equality(depth + 1);
    while (isPunct('&&')) {
      eat('&&');
      left = { type: 'binary', op: '&&', left, right: equality(depth + 1) };
    }
    return left;
  }

  function equality(depth: number): ExprNode {
    guard(depth);
    let left = comparison(depth + 1);
    while (isPunct('==') || isPunct('!=')) {
      const op = (next() as { v: BinOp }).v;
      left = { type: 'binary', op, left, right: comparison(depth + 1) };
    }
    return left;
  }

  function comparison(depth: number): ExprNode {
    guard(depth);
    let left = additive(depth + 1);
    while (isPunct('<') || isPunct('>') || isPunct('<=') || isPunct('>=')) {
      const op = (next() as { v: BinOp }).v;
      left = { type: 'binary', op, left, right: additive(depth + 1) };
    }
    return left;
  }

  function additive(depth: number): ExprNode {
    guard(depth);
    let left = multiplicative(depth + 1);
    while (isPunct('+') || isPunct('-')) {
      const op = (next() as { v: BinOp }).v;
      left = { type: 'binary', op, left, right: multiplicative(depth + 1) };
    }
    return left;
  }

  function multiplicative(depth: number): ExprNode {
    guard(depth);
    let left = unary(depth + 1);
    while (isPunct('*') || isPunct('/')) {
      const op = (next() as { v: BinOp }).v;
      left = { type: 'binary', op, left, right: unary(depth + 1) };
    }
    return left;
  }

  function unary(depth: number): ExprNode {
    guard(depth);
    if (isPunct('!') || isPunct('-')) {
      const op = (next() as { v: UnOp }).v;
      return { type: 'unary', op, arg: unary(depth + 1) };
    }
    return primary(depth + 1);
  }

  function primary(depth: number): ExprNode {
    guard(depth);
    const t = peek();
    if (!t) throw new ParseError('unexpected end of expression');
    if (t.k === 'num') {
      next();
      return { type: 'num', value: t.v };
    }
    if (t.k === 'str') {
      next();
      return { type: 'str', value: t.v };
    }
    if (t.k === 'ident') {
      next();
      if (t.v === 'true') return { type: 'bool', value: true };
      if (t.v === 'false') return { type: 'bool', value: false };
      if (t.v === 'fn') {
        eat('.');
        const id = peek();
        if (!id || id.k !== 'ident') throw new ParseError('expected a function id after "fn."');
        next();
        refs.add(id.v);
        return { type: 'ref', id: id.v };
      }
      throw new ParseError(`unknown identifier "${t.v}" (only fn.<id>, true, false allowed)`);
    }
    if (t.k === 'punct' && t.v === '(') {
      eat('(');
      const inner = ternary(depth + 1);
      eat(')');
      return inner;
    }
    throw new ParseError(`unexpected token "${t.v}"`);
  }

  const ast = ternary(0);
  if (pos !== tokens.length) {
    const t = tokens[pos];
    throw new ParseError(`unexpected trailing token "${t.k === 'num' ? t.v : (t as { v: unknown }).v}"`);
  }
  return { ast, refs: [...refs] };
}

/**
 * Parse an expression string into an AST + the set of function ids it references. Returns a typed
 * error on any lex/parse failure or if the depth/complexity cap is exceeded — the caller turns
 * that into an author-time `{path, reason, fix}` issue.
 */
export function parseExpr(src: string): ParseExprResult {
  if (typeof src !== 'string' || src.trim() === '') {
    return { ok: false, error: 'expression is empty' };
  }
  const lexed = tokenize(src);
  if (!lexed.ok) return { ok: false, error: lexed.error };
  if (lexed.tokens.length === 0) return { ok: false, error: 'expression is empty' };
  try {
    const { ast, refs } = parse(lexed.tokens);
    return { ok: true, ast, refs };
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : `parse error: ${String(e)}` };
  }
}

// -------------------------------------------------------------------------- evaluate --

/** A resolved function value: a number, a boolean, or null ("no value"). */
export type ExprValue = number | boolean | null;

/**
 * Evaluate an AST purely against a map of resolved function values. NEVER throws: any type error,
 * unknown ref, or division by zero yields `null`. Boolean operators short-circuit. A depth guard
 * mirrors the parse cap so even a hand-built oversized AST is safe.
 */
export function evaluateExpr(ast: ExprNode, values: Readonly<Record<string, ExprValue>>): ExprValue {
  function num(v: ExprValue): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  function bool(v: ExprValue): boolean | null {
    return typeof v === 'boolean' ? v : null;
  }

  function walk(node: ExprNode, depth: number): ExprValue {
    if (depth > MAX_DEPTH) return null;
    switch (node.type) {
      case 'num':
        return node.value;
      case 'str':
        // Strings are only meaningful as operands of == / != (see binary); a bare string → null.
        return null;
      case 'bool':
        return node.value;
      case 'ref': {
        const v = values[node.id];
        return v === undefined ? null : v;
      }
      case 'unary': {
        if (node.op === '!') {
          const b = bool(walk(node.arg, depth + 1));
          return b === null ? null : !b;
        }
        const nv = num(walk(node.arg, depth + 1));
        return nv === null ? null : -nv;
      }
      case 'ternary': {
        const c = bool(walk(node.cond, depth + 1));
        if (c === null) return null;
        return walk(c ? node.then : node.else, depth + 1);
      }
      case 'binary':
        return binary(node, depth);
    }
  }

  // Resolve an operand to its comparable primitive: string nodes keep their string; refs/others
  // resolve via walk. Used ONLY by == / != so `fn.x == "open"`-style checks work honestly.
  function operand(node: ExprNode, depth: number): number | boolean | string | null {
    if (node.type === 'str') return node.value;
    return walk(node, depth + 1);
  }

  function binary(node: Extract<ExprNode, { type: 'binary' }>, depth: number): ExprValue {
    const { op } = node;
    // boolean short-circuit
    if (op === '&&') {
      const l = bool(walk(node.left, depth + 1));
      if (l === null) return null;
      if (!l) return false;
      return bool(walk(node.right, depth + 1));
    }
    if (op === '||') {
      const l = bool(walk(node.left, depth + 1));
      if (l === null) return null;
      if (l) return true;
      return bool(walk(node.right, depth + 1));
    }
    // equality: compare primitives (number/boolean/string) with strict, type-aware semantics.
    if (op === '==' || op === '!=') {
      const l = operand(node.left, depth + 1);
      const r = operand(node.right, depth + 1);
      if (l === null || r === null) return null;
      const eq = typeof l === typeof r ? l === r : false;
      return op === '==' ? eq : !eq;
    }
    // arithmetic + numeric comparison: both operands must be finite numbers.
    const l = num(walk(node.left, depth + 1));
    const r = num(walk(node.right, depth + 1));
    if (l === null || r === null) return null;
    switch (op) {
      case '+':
        return l + r;
      case '-':
        return l - r;
      case '*':
        return l * r;
      case '/':
        return r === 0 ? null : l / r; // division by zero → null (never Infinity/NaN)
      case '<':
        return l < r;
      case '>':
        return l > r;
      case '<=':
        return l <= r;
      case '>=':
        return l >= r;
    }
  }

  return walk(ast, 0);
}
