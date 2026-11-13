/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `when` evaluator tests — the grammar, truthiness, errors and channel discovery
 * USER STORY: As the engine-rebuild engineer I want the guard language pinned by tests so a
 *             system.yaml guard can never be reinterpreted silently.
 * ARCHITECTURE:
 *   - Pure unit tests over `parseWhen` / `evaluateWhen` / `whenChannels`; no graph, no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWhen, isTruthy, parseWhen, whenChannels, WhenSyntaxError } from '@tabs/agents/lib/engine/when';

test('literals and absent guards', () => {
  assert.equal(evaluateWhen('true', {}), true);
  assert.equal(evaluateWhen('false', {}), false);
  assert.equal(evaluateWhen(null, {}), true, 'absent guard is unconditional');
  assert.equal(evaluateWhen('   ', {}), true, 'blank guard is unconditional');
  assert.equal(evaluateWhen("'yes'", {}), true, 'a non-empty string literal is truthy');
  assert.equal(evaluateWhen('""', {}), false, 'an empty string literal is falsy');
});

test('state.<channel> and bare identifiers resolve to the same channel', () => {
  const ch = { findings_ready: true, plan_ready: false, phase: 'build' };
  assert.equal(evaluateWhen('state.findings_ready', ch), true);
  assert.equal(evaluateWhen('findings_ready', ch), true);
  assert.equal(evaluateWhen('plan_ready', ch), false);
  assert.equal(evaluateWhen('state.unknown', ch), false, 'an unset channel is false');
  assert.equal(evaluateWhen('committed', {}), false, 'the shipped software team guards are false until set');
});

test('equality, and, or, parentheses, precedence', () => {
  const ch = { phase: 'build', ok: true, count: 0 };
  assert.equal(evaluateWhen("phase == 'build'", ch), true);
  assert.equal(evaluateWhen('state.phase != "build"', ch), false);
  assert.equal(evaluateWhen("phase == 'test' || ok", ch), true);
  assert.equal(evaluateWhen("phase == 'build' && count", ch), false, '0 is falsy');
  assert.equal(evaluateWhen("(phase == 'test' || ok) && phase == 'build'", ch), true);
  // && binds tighter than ||: false || (true && true)
  assert.equal(evaluateWhen("phase == 'x' || ok && phase == 'build'", ch), true);
  assert.equal(evaluateWhen('ok == true', ch), true);
  assert.equal(evaluateWhen("count == '0'", ch), true, 'primitives compare by value across string/number');
});

test('truthiness is explicit', () => {
  assert.equal(isTruthy([]), false);
  assert.equal(isTruthy([1]), true);
  assert.equal(isTruthy(''), false);
  assert.equal(isTruthy('x'), true);
  assert.equal(isTruthy(0), false);
  assert.equal(isTruthy(null), false);
  assert.equal(isTruthy({}), true);
});

test('syntax errors are typed and never evaluated', () => {
  for (const bad of ['', 'a ==', '(a', "'unterminated", 'a && || b', 'a b', 'state.', '1 + 2', 'eval(x)']) {
    assert.throws(() => parseWhen(bad), WhenSyntaxError, `expected a syntax error for ${JSON.stringify(bad)}`);
  }
});

test('whenChannels lists every channel an expression reads, once, in order', () => {
  assert.deepEqual(whenChannels(parseWhen("state.a && (b || a) || c == 'x'")), ['a', 'b', 'c']);
  assert.deepEqual(whenChannels(parseWhen('true')), []);
});
