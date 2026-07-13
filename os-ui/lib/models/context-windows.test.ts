/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelContext,
  inputBudget,
  safetyHeadroom,
  parseOverrides,
  DEFAULT_MODEL_CONTEXTS,
  UNKNOWN_MODEL_CONTEXT,
} from './context-windows.ts';

test('modelContext returns the built-in default for a known sovereign model', () => {
  const ctx = modelContext('sovereign-reasoning', {});
  assert.deepEqual(ctx, DEFAULT_MODEL_CONTEXTS['sovereign-reasoning']);
  assert.equal(ctx.contextWindow, 200_000);
});

test('modelContext falls back to the conservative unknown context', () => {
  assert.deepEqual(modelContext('some-mystery-model', {}), UNKNOWN_MODEL_CONTEXT);
});

test('an admin/env override wins over the built-in default', () => {
  const overrides = { 'sovereign-default': { contextWindow: 64_000, reservedOutput: 2_000 } };
  assert.deepEqual(modelContext('sovereign-default', overrides), {
    contextWindow: 64_000,
    reservedOutput: 2_000,
  });
});

test('inputBudget subtracts reservedOutput AND a safety headroom', () => {
  assert.equal(inputBudget('sovereign-reasoning', {}), 200_000 - 8_000 - safetyHeadroom(200_000));
  assert.equal(inputBudget('sovereign-default', {}), 128_000 - 4_000 - safetyHeadroom(128_000));
});

test('INVARIANT: inputBudget + reservedOutput stays strictly under the window (the 400 fix)', () => {
  // The request sends input(≤inputBudget) + max_tokens(=reservedOutput). That sum
  // MUST leave real slack under the window, or the tokenizer drift tips it over.
  for (const [name, { contextWindow, reservedOutput }] of Object.entries(DEFAULT_MODEL_CONTEXTS)) {
    if (reservedOutput === 0) continue; // embeddings — not a chat budget
    const total = inputBudget(name, {}) + reservedOutput;
    assert.ok(total < contextWindow, `${name}: ${total} must be < ${contextWindow}`);
    assert.ok(contextWindow - total >= 2_000, `${name}: needs ≥2000 tokens of headroom`);
  }
});

test('parseOverrides ignores malformed JSON and bad entries', () => {
  assert.deepEqual(parseOverrides('not json'), {});
  assert.deepEqual(parseOverrides(undefined), {});
  // A valid entry survives; entries with a non-numeric window are dropped.
  const parsed = parseOverrides('{"a":{"contextWindow":1000,"reservedOutput":100},"b":{"contextWindow":"x"}}');
  assert.deepEqual(parsed, { a: { contextWindow: 1000, reservedOutput: 100 } });
});

test('parseOverrides clamps a reserve that would swallow the whole window', () => {
  const parsed = parseOverrides('{"a":{"contextWindow":1000,"reservedOutput":5000}}');
  assert.equal(parsed.a.reservedOutput, 999);
});
