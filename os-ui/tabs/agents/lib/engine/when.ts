/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `when` guard evaluator — the safe expression language of a handoff edge
 * USER STORY: As a builder I want a handoff's `when:` to be a small, predictable expression
 *             over the team's state channels (never a model's opinion and never arbitrary
 *             code) so I can read a system.yaml and know exactly when control moves.
 * ARCHITECTURE:
 *   - Grammar v1 (plan 2026-11-13-engine-rebuild, Phase A1):
 *       expr    := or
 *       or      := and ( '||' and )*
 *       and     := eq  ( '&&' eq  )*
 *       eq      := primary ( ( '==' | '!=' ) primary )?
 *       primary := 'true' | 'false' | <string literal '…' or "…">
 *                | 'state' '.' <ident>          (a declared channel)
 *                | <ident>                      (bare identifier = the channel of that name)
 *                | '(' expr ')'
 *     Truthiness of a channel value is JS-like but explicit (`isTruthy`): undefined / null /
 *     false / '' / 0 / an empty array are false; everything else is true. Equality compares
 *     primitives by value (a string literal against a string channel), never objects.
 *   - A hand-written tokenizer + recursive-descent parser. NEVER `eval` / `new Function`; the
 *     AST is data and `evaluateWhen` is a pure fold over it. A syntax error is a typed
 *     `WhenSyntaxError` the graph builder turns into a compile error naming the edge.
 *   - `whenChannels(ast)` lists the channels an expression reads, so `buildGraph` can warn
 *     about a guard over a channel no node ever sets (an always-false guard must be visible
 *     in Build, not silent).
 */

export type WhenAst =
  | { kind: 'literal'; value: boolean | string }
  | { kind: 'channel'; name: string }
  | { kind: 'eq'; op: '==' | '!='; left: WhenAst; right: WhenAst }
  | { kind: 'and'; left: WhenAst; right: WhenAst }
  | { kind: 'or'; left: WhenAst; right: WhenAst };

export class WhenSyntaxError extends Error {
  expression: string;
  position: number;
  constructor(expression: string, position: number, message: string) {
    super(`when "${expression}": ${message} (at offset ${position})`);
    this.name = 'WhenSyntaxError';
    this.expression = expression;
    this.position = position;
  }
}

type Token =
  | { t: 'ident'; v: string; at: number }
  | { t: 'string'; v: string; at: number }
  | { t: 'op'; v: '==' | '!=' | '&&' | '||' | '(' | ')' | '.'; at: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '(' || c === ')' || c === '.') { out.push({ t: 'op', v: c, at: i }); i += 1; continue; }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '&&' || two === '||') { out.push({ t: 'op', v: two, at: i }); i += 2; continue; }
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, i + 1);
      if (close < 0) throw new WhenSyntaxError(src, i, 'unterminated string literal');
      out.push({ t: 'string', v: src.slice(i + 1, close), at: i });
      i = close + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      out.push({ t: 'ident', v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    throw new WhenSyntaxError(src, i, `unexpected character '${c}'`);
  }
  return out;
}

/** Parse a `when` expression into its AST. Throws {@link WhenSyntaxError}. */
/** Longest `when` expression accepted (characters). */
export const MAX_WHEN_LENGTH = 512;

export function parseWhen(expression: string): WhenAst {
  const src = expression.trim();
  if (src.length === 0) throw new WhenSyntaxError(expression, 0, 'empty expression');
  // A bound on the source keeps the recursive descent from overflowing the stack on a pathological
  // guard (10k parentheses) — a typed syntax error, never a RangeError (review finding L1).
  if (src.length > MAX_WHEN_LENGTH) throw new WhenSyntaxError(expression, MAX_WHEN_LENGTH, `expression longer than ${MAX_WHEN_LENGTH} characters`);
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const take = () => toks[pos++];
  const fail = (msg: string): never => {
    throw new WhenSyntaxError(src, peek()?.at ?? src.length, msg);
  };
  const isOp = (v: string) => { const p = peek(); return p !== undefined && p.t === 'op' && p.v === v; };

  function parseOr(): WhenAst {
    let left = parseAnd();
    while (isOp('||')) { take(); left = { kind: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): WhenAst {
    let left = parseEq();
    while (isOp('&&')) { take(); left = { kind: 'and', left, right: parseEq() }; }
    return left;
  }
  function parseEq(): WhenAst {
    const left = parsePrimary();
    if (isOp('==') || isOp('!=')) {
      const op = (take() as { v: '==' | '!=' }).v;
      return { kind: 'eq', op, left, right: parsePrimary() };
    }
    return left;
  }
  function parsePrimary(): WhenAst {
    const tok = peek();
    if (!tok) return fail('unexpected end of expression');
    if (tok.t === 'string') { take(); return { kind: 'literal', value: tok.v }; }
    if (tok.t === 'op' && tok.v === '(') {
      take();
      const inner = parseOr();
      if (!isOp(')')) return fail("expected ')'");
      take();
      return inner;
    }
    if (tok.t === 'ident') {
      take();
      if (tok.v === 'true') return { kind: 'literal', value: true };
      if (tok.v === 'false') return { kind: 'literal', value: false };
      if (tok.v === 'state') {
        if (!isOp('.')) return fail("expected '.' after 'state'");
        take();
        const name = peek();
        if (!name || name.t !== 'ident') return fail("expected a channel name after 'state.'");
        take();
        return { kind: 'channel', name: name.v };
      }
      return { kind: 'channel', name: tok.v };
    }
    return fail(`unexpected token '${tok.v}'`);
  }

  const ast = parseOr();
  if (pos < toks.length) fail(`unexpected trailing token '${toks[pos].v}'`);
  return ast;
}

/** Explicit truthiness: undefined/null/false/''/0/[] are false; everything else is true. */
export function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function primitiveEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(a) === String(b);
}

function evalAst(ast: WhenAst, channels: Record<string, unknown>): unknown {
  switch (ast.kind) {
    case 'literal': return ast.value;
    case 'channel': return Object.prototype.hasOwnProperty.call(channels, ast.name) ? channels[ast.name] : undefined;
    case 'eq': {
      const same = primitiveEq(evalAst(ast.left, channels), evalAst(ast.right, channels));
      return ast.op === '==' ? same : !same;
    }
    case 'and': return isTruthy(evalAst(ast.left, channels)) && isTruthy(evalAst(ast.right, channels));
    case 'or': return isTruthy(evalAst(ast.left, channels)) || isTruthy(evalAst(ast.right, channels));
  }
}

/**
 * Evaluate a `when` guard against the current channel values. An absent/empty guard is
 * unconditional (true). Accepts a pre-parsed AST so the graph builder can parse once.
 */
export function evaluateWhen(guard: string | WhenAst | null | undefined, channels: Record<string, unknown>): boolean {
  if (guard === null || guard === undefined) return true;
  if (typeof guard === 'string' && guard.trim().length === 0) return true;
  const ast = typeof guard === 'string' ? parseWhen(guard) : guard;
  return isTruthy(evalAst(ast, channels));
}

/** The distinct channel names an expression reads, in first-seen order. */
export function whenChannels(ast: WhenAst): string[] {
  const out: string[] = [];
  const walk = (n: WhenAst) => {
    if (n.kind === 'channel') { if (!out.includes(n.name)) out.push(n.name); return; }
    if (n.kind === 'literal') return;
    walk(n.left);
    walk(n.right);
  };
  walk(ast);
  return out;
}
