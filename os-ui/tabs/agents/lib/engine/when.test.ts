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

// --- F0: the proposer's old label, read deliberately --------------------------------------------

import { isLegacyUnguardedWhen, whenProblem } from '@tabs/agents/lib/engine/when';

test('isLegacyUnguardedWhen: "<words> complete" that cannot be an expression is the old "then" label', () => {
  for (const label of ['step complete', ' Step  Complete ', 'research complete', 'Pulls the raw campaign data complete', 'Checks margins (after returns) complete', 'Q&A drafting complete', 'Writes the report. complete']) {
    assert.equal(isLegacyUnguardedWhen(label), true, label);
  }
});

test('isLegacyUnguardedWhen: anything that IS an expression, or was meant as one, is not forgiven', () => {
  // A real expression is a guard, whatever words it uses.
  for (const expr of ['complete', 'state.complete', 'done || complete', "status == 'complete'", 'true']) {
    assert.equal(isLegacyUnguardedWhen(expr), false, expr);
    assert.doesNotThrow(() => parseWhen(expr));
  }
  // A broken guard that someone WROTE as a condition must stay an error — never a silent "always".
  for (const broken of ['state.done && tests complete', 'reviewed == true complete', 'a || b complete', 'x != y is complete', 'step done', 'complete step', '']) {
    assert.equal(isLegacyUnguardedWhen(broken), false, broken);
  }
});

test('whenProblem: null for no guard, a valid guard and the legacy label; the syntax error otherwise', () => {
  assert.equal(whenProblem(undefined), null);
  assert.equal(whenProblem('   '), null);
  assert.equal(whenProblem('plan_ready && !x' .replace('!x', 'state.ok')), null);
  assert.equal(whenProblem('research complete'), null);
  assert.match(whenProblem('research done') ?? '', /unexpected trailing token 'done'/);
});
