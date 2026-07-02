/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentChatResponse, stripThinking } from './agent-chat-response.ts';

test('a well-formed 200 reply yields the assistant content', () => {
  const r = parseAgentChatResponse(true, 200, JSON.stringify({ content: 'hello there', model: 'x' }));
  assert.deepEqual(r, { content: 'hello there' });
});

test('a JSON error body on a non-200 yields that error message', () => {
  const r = parseAgentChatResponse(false, 502, JSON.stringify({ error: 'LiteLLM 500: model dead' }));
  assert.deepEqual(r, { error: 'LiteLLM 500: model dead' });
});

test('a NON-JSON body (dead model) does NOT throw and yields a clean error', () => {
  // This is the regression: res.json() would throw "The string did not match the
  // expected pattern." on an HTML/empty body. The helper must return a message.
  const r = parseAgentChatResponse(false, 502, '<html><body>502 Bad Gateway</body></html>');
  assert.ok('error' in r);
  assert.match((r as { error: string }).error, /unavailable|error 502/i);
});

test('an empty 200 body yields a clean error, not a throw', () => {
  const r = parseAgentChatResponse(true, 200, '');
  assert.ok('error' in r);
  assert.match((r as { error: string }).error, /unexpected/i);
});

test('a 200 with unparseable body yields a clean error', () => {
  const r = parseAgentChatResponse(true, 200, 'not json at all');
  assert.ok('error' in r);
});

test('never throws across a matrix of malformed inputs', () => {
  const cases: Array<[boolean, number, string]> = [
    [true, 200, '{"content":123}'], // wrong content type -> error branch
    [false, 429, '{"error":"budget exhausted"}'],
    [false, 500, ''],
    [true, 200, '{"nope":true}'],
  ];
  for (const [ok, status, body] of cases) {
    assert.doesNotThrow(() => parseAgentChatResponse(ok, status, body));
  }
});

// ---- stripThinking: remove Qwen chain-of-thought scaffolding from display ----

test('plain content is returned untouched (trimmed)', () => {
  assert.equal(stripThinking('The answer is 42.'), 'The answer is 42.');
  assert.equal(stripThinking('  hello  '), 'hello');
});

test('a matched <think>…</think> block is removed', () => {
  assert.equal(
    stripThinking('<think>let me reason about this</think>The answer is 42.'),
    'The answer is 42.',
  );
});

test('multiple and mid-string <think> blocks are removed', () => {
  assert.equal(
    stripThinking('Here is a plan. <think>hmm</think>Then <think>more</think>done.'),
    'Here is a plan. Then done.',
  );
});

test('a "Here\'s a thinking process: … </think>" preamble is stripped', () => {
  const raw = "Here's a thinking process: I should first list the fields. </think>\n\nAdd a status filter and CSV export.";
  assert.equal(stripThinking(raw), 'Add a status filter and CSV export.');
});

test('a dangling unclosed <think> tail is dropped, keeping the answer before it', () => {
  assert.equal(stripThinking('The answer is 42. <think>still reasoning...'), 'The answer is 42.');
});

test('does NOT eat a normal reply that merely starts with "Here\'s" (no </think>)', () => {
  const raw = "Here's the CSV export you asked for.";
  assert.equal(stripThinking(raw), raw);
});

test('stripThinking never throws on odd input', () => {
  for (const v of ['', '<think>', '</think>', '<think></think>', 'no tags at all']) {
    assert.doesNotThrow(() => stripThinking(v));
  }
});

test('parseAgentChatResponse strips think blocks from returned content', () => {
  const r = parseAgentChatResponse(true, 200, JSON.stringify({ content: '<think>reasoning</think>Hello.' }));
  assert.deepEqual(r, { content: 'Hello.' });
});
