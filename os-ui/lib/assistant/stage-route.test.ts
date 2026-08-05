/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStageJson } from './stage-route.ts';

/**
 * `parseStageJson` is the ONE shape guard shared stage assistants use for both the
 * escalation validator and the final response. It now delegates to the tolerant
 * `parseJsonReply` so a reasoning model that wraps its JSON in preamble/thinking or a
 * ```json fence still yields structured suggestions instead of an empty result.
 */

test('object stage: parses a clean object', () => {
  assert.deepEqual(parseStageJson('{"taskType":"regression"}'), { taskType: 'regression' });
});

test('object stage: recovers an object wrapped in reasoning preamble (the landmine)', () => {
  const reply = 'Let me think… here is the definition:\n{"taskType":"binary_classification","targetColumn":"churned"}\nDone.';
  assert.deepEqual(parseStageJson(reply), { taskType: 'binary_classification', targetColumn: 'churned' });
});

test('object stage: recovers a ```json fenced object', () => {
  assert.deepEqual(parseStageJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('object stage: an ARRAY is rejected (wrong shape → null)', () => {
  assert.equal(parseStageJson('[1,2,3]'), null);
});

test('object stage: unusable prose → null', () => {
  assert.equal(parseStageJson('sorry, I cannot help with that'), null);
});

test('array stage (expectArray): parses a clean array', () => {
  assert.deepEqual(parseStageJson('[{"viz":"bar"}]', true), [{ viz: 'bar' }]);
});

test('array stage (expectArray): recovers an array wrapped in prose + fence', () => {
  const reply = 'Here are the panels:\n```json\n[{"viz":"line"}]\n```';
  assert.deepEqual(parseStageJson(reply, true), [{ viz: 'line' }]);
});

test('array stage (expectArray): an OBJECT is rejected (wrong shape → null)', () => {
  assert.equal(parseStageJson('{"not":"array"}', true), null);
});
