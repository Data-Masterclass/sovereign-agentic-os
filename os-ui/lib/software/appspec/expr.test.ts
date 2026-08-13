/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * expr.test — the pure, safe expression grammar behind AppSpec `functions[]` (kind:'expression').
 * Pins the SAFETY PROPERTIES that are the whole point: no eval (it's a pure tree-walker), correct
 * precedence + ternary + boolean short-circuit, division-by-zero → null, unknown `fn.<id>` ref →
 * null, and a DEPTH/complexity cap so a pathological expression can't blow the stack or churn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpr, evaluateExpr, MAX_DEPTH, MAX_TOKENS, type ExprValue } from './expr.ts';

/** Parse then evaluate against a values map; returns null if parse fails. */
function evl(src: string, values: Record<string, ExprValue> = {}): ExprValue {
  const p = parseExpr(src);
  if (!p.ok) return null;
  return evaluateExpr(p.ast, values);
}

test('literals: numbers, booleans', () => {
  assert.equal(evl('42'), 42);
  assert.equal(evl('3.5'), 3.5);
  assert.equal(evl('true'), true);
  assert.equal(evl('false'), false);
});

test('arithmetic precedence: * / before + -', () => {
  assert.equal(evl('2 + 3 * 4'), 14);
  assert.equal(evl('(2 + 3) * 4'), 20);
  assert.equal(evl('10 - 2 - 3'), 5); // left-assoc
  assert.equal(evl('20 / 4 / 5'), 1); // left-assoc
  assert.equal(evl('-3 + 5'), 2); // unary minus
});

test('comparison + equality precedence and results', () => {
  assert.equal(evl('2 + 3 > 4'), true);
  assert.equal(evl('5 == 5'), true);
  assert.equal(evl('5 != 5'), false);
  assert.equal(evl('1 < 2'), true);
  assert.equal(evl('2 <= 2'), true);
  assert.equal(evl('3 >= 4'), false);
});

test('boolean operators and precedence (&& binds tighter than ||)', () => {
  assert.equal(evl('true && false'), false);
  assert.equal(evl('true || false'), true);
  assert.equal(evl('false || true && false'), false); // = false || (true && false)
  assert.equal(evl('!true'), false);
  assert.equal(evl('!(1 > 2)'), true);
});

test('ternary evaluates the correct branch (and nests right-assoc)', () => {
  assert.equal(evl('true ? 1 : 2'), 1);
  assert.equal(evl('false ? 1 : 2'), 2);
  assert.equal(evl('1 > 2 ? 10 : 3 > 2 ? 20 : 30'), 20);
});

test('fn.<id> references resolve from the values map', () => {
  assert.equal(evl('fn.a + fn.b', { a: 10, b: 5 }), 15);
  assert.equal(evl('fn.total / fn.count', { total: 100, count: 4 }), 25);
  assert.equal(evl('fn.ok ? fn.hi : fn.lo', { ok: true, hi: 9, lo: 1 }), 9);
});

test('parse extracts the referenced function ids', () => {
  const p = parseExpr('fn.a + fn.b * fn.a');
  assert.ok(p.ok);
  if (p.ok) assert.deepEqual([...p.refs].sort(), ['a', 'b']);
});

test('division by zero → null (never Infinity/NaN)', () => {
  assert.equal(evl('1 / 0'), null);
  assert.equal(evl('fn.x / fn.y', { x: 10, y: 0 }), null);
});

test('unknown ref → null; propagates through arithmetic', () => {
  assert.equal(evl('fn.missing', {}), null);
  assert.equal(evl('fn.missing + 1', {}), null);
  assert.equal(evl('fn.a + fn.missing', { a: 5 }), null);
});

test('type mismatches → null, honestly (no coercion)', () => {
  assert.equal(evl('fn.b + 1', { b: true }), null); // boolean in arithmetic
  assert.equal(evl('fn.n && true', { n: 5 }), null); // number in boolean
  assert.equal(evl('1 ? 2 : 3'), null); // non-boolean ternary condition
});

test('string equality works for literal checks; mixed types are not equal', () => {
  assert.equal(evl('"open" == "open"'), true);
  assert.equal(evl('"open" != "closed"'), true);
  assert.equal(evl('"5" == 5'), false); // different types → not equal
  // A ref (only ever number|boolean|null) compared to a string literal that doesn't match → false
  // when both are non-null of the same type; a null ref against a string → null (no value).
  assert.equal(evl('fn.s == "open"', { s: null }), null);
});

test('boolean short-circuit: right side not needed when left decides', () => {
  // If the right operand were a hard error, short-circuit still yields the left-decided value.
  assert.equal(evl('false && fn.x', { x: 1 }), false); // never coerces fn.x
  assert.equal(evl('true || fn.x', { x: 1 }), true);
});

test('depth cap: a pathological deeply-nested expression is REJECTED at parse (no stack blow)', () => {
  const deep = '('.repeat(MAX_DEPTH + 5) + '1' + ')'.repeat(MAX_DEPTH + 5);
  const p = parseExpr(deep);
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.error, /deep/);
});

test('a shallow expression well under the depth cap parses fine', () => {
  assert.equal(evl('((((1 + 2))))'), 3);
});

test('token/complexity cap: an enormous flat expression is rejected', () => {
  const huge = Array(MAX_TOKENS + 10).fill('1').join(' + ');
  const p = parseExpr(huge);
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.error, /too long/);
});

test('parse errors are typed, not thrown', () => {
  for (const bad of ['', '1 +', '(1', '1)', 'foo', '1 @ 2', 'fn.', '1 2']) {
    const p = parseExpr(bad);
    assert.equal(p.ok, false, `"${bad}" should not parse`);
  }
});

test('no eval / no property access: an unknown identifier is a parse error', () => {
  // "constructor", "process", "window" etc. are plain unknown identifiers, never resolved.
  for (const id of ['constructor', 'process', 'window', 'globalThis']) {
    const p = parseExpr(id);
    assert.equal(p.ok, false);
    if (!p.ok) assert.match(p.error, /unknown identifier/);
  }
});
