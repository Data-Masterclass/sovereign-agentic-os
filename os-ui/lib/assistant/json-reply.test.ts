/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, parseJsonReply } from './json-reply.ts';

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
