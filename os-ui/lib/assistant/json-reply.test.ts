/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, extractJsonArray, parseJsonReply, parseJsonArrayReply } from './json-reply.ts';

test('parses a clean JSON object (fast path)', () => {
  assert.deepEqual(parseJsonReply('{"message":"hi","suggestedEpics":[]}'), { message: 'hi', suggestedEpics: [] });
});

test('parses a ```json fenced object', () => {
  const r = parseJsonReply('```json\n{"a":1}\n```');
  assert.deepEqual(r, { a: 1 });
});

test('recovers JSON wrapped in reasoning preamble + trailing note', () => {
  // The Design failure mode: the reasoning model narrates before/after the object.
  const reply =
    'Here is the plan for the app:\n{"message":"Two epics proposed.","suggestedEpics":[{"title":"Invoices"}]}\nLet me know if you want more.';
  const r = parseJsonReply(reply) as { suggestedEpics: { title: string }[] };
  assert.equal(r.suggestedEpics[0].title, 'Invoices');
});

test('a brace inside a string value never miscounts depth', () => {
  const reply = 'note: {"message":"use { and } carefully","ok":true}';
  assert.deepEqual(parseJsonReply(reply), { message: 'use { and } carefully', ok: true });
});

test('returns null when there is no usable object', () => {
  assert.equal(parseJsonReply('sorry, I could not do that'), null);
  assert.equal(extractJsonObject('no braces here'), null);
  assert.equal(extractJsonObject('{ unterminated'), null); // no closing brace → null
});

test('extractJsonArray finds a balanced top-level array (string-safe)', () => {
  assert.equal(extractJsonArray('prefix [1, 2, "]"] suffix'), '[1, 2, "]"]');
  assert.equal(extractJsonArray('no array here'), null);
  assert.equal(extractJsonArray('[ unterminated'), null);
});

test('parseJsonArrayReply parses a clean array (fast path)', () => {
  assert.deepEqual(parseJsonArrayReply('[{"name":"A"},{"name":"B"}]'), [{ name: 'A' }, { name: 'B' }]);
});

test('parseJsonArrayReply recovers an array wrapped in reasoning preamble + fence', () => {
  const reply = 'Here are the charts:\n```json\n[{"viz":"bar"}]\n```\nHope that helps.';
  assert.deepEqual(parseJsonArrayReply(reply), [{ viz: 'bar' }]);
});

test('parseJsonArrayReply returns null for an object or junk', () => {
  assert.equal(parseJsonArrayReply('{"not":"an array"}'), null);
  assert.equal(parseJsonArrayReply('nope'), null);
});
