/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    Recognise a tool call written as text, in each model family's documented markup (detection only)
 * USER STORY: As the owner I never see a model's textual tool call presented as an agent's answer.
 * ARCHITECTURE: pure function tests; the shapes have twins that must NOT be flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTextToolCall, TextToolCallError } from '@core/runtime/text-tool-call';
import { parseLlmMessage } from '@core/runtime/runtime';

const CALLS: Record<string, string> = {
  'qwen/hermes (the dev incident)': '<tool_call>\n{"name": "delegate_to_worker", "arguments": {"preset": "summarise_tool_result"}}\n</tool_call>',
  'qwen3-coder xml': '<tool_call>\n<function=search_knowledge>\n<parameter=query>\nrevenue\n</parameter>\n</function>\n</tool_call>',
  kimi: '<|tool_calls_section_begin|><|tool_call_begin|>functions.query_data:0<|tool_call_argument_begin|>{"sql":"select 1"}<|tool_call_end|><|tool_calls_section_end|>',
  'deepseek v3': '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>query_data\n```json\n{"sql":"select 1"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  'deepseek v3.1': '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>query_data<｜tool▁sep｜>{"sql":"select 1"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  'gpt-oss harmony': '<|start|>assistant<|channel|>commentary to=functions.query_data <|constrain|>json<|message|>{"sql":"select 1"}<|call|>',
  '<|tool_call|>': '<|tool_call|>[{"name": "query_data", "arguments": {"sql": "select 1"}}]',
  mistral: '[TOOL_CALLS][{"name": "query_data", "arguments": {"sql": "select 1"}}]',
  'openai function-call json': '{"name": "query_data", "arguments": {"sql": "select 1"}}',
  'llama parameters json, fenced': '```json\n{"name": "query_data", "parameters": {"sql": "select 1"}}\n```',
  'type/function json': '{"type": "function", "function": {"name": "query_data", "arguments": "{\\"sql\\":\\"select 1\\"}"}}',
  'tool_calls list': '{"tool_calls": [{"type": "function", "function": {"name": "query_data", "arguments": {}}}]}',
};

for (const [name, text] of Object.entries(CALLS)) {
  test(`DETECTED: ${name}`, () => assert.ok(detectTextToolCall(text), text));
}

const ANSWERS: Record<string, string> = {
  prose: 'Revenue grew 12% in Q3. I checked it with query_data.',
  'markdown with a json data block': 'Here is the record:\n```json\n{"name": "Acme GmbH", "revenue": 120000}\n```',
  'a data object with name and parameters plus more fields': '{"name": "Acme", "parameters": {"tier": 1}, "revenue": 3}',
  'json list of data': '[{"name": "Acme", "city": "Berlin"}]',
  empty: '',
};
for (const [name, text] of Object.entries(ANSWERS)) {
  test(`NOT A CALL (twin): ${name}`, () => assert.equal(detectTextToolCall(text), null));
}

test('parseLlmMessage records a textual call only when no native call came back', () => {
  assert.ok(parseLlmMessage({ content: CALLS['qwen/hermes (the dev incident)'] }).textToolCall);
  const native = parseLlmMessage({ content: '<tool_call>x</tool_call>', tool_calls: [{ id: 'a', function: { name: 'whoami', arguments: '{}' } }] });
  assert.equal(native.textToolCall, undefined);
  assert.equal(parseLlmMessage({ content: 'plain answer' }).textToolCall, undefined);
});

test('TextToolCallError is typed and says what happened in plain words', () => {
  const e = new TextToolCallError('qwen/hermes <tool_call>');
  assert.equal(e.code, 'text_tool_call');
  assert.equal(e.name, 'TextToolCallError');
  assert.match(e.message, /^the model wrote a tool call as text instead of calling it/);
});
