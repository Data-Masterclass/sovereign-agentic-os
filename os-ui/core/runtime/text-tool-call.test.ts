/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    Recognise a reply that IS a tool call written as text, in each model family's documented markup (detection only)
 * USER STORY: As the owner I never see a model's textual tool call presented as an agent's answer — and a normal answer
 *             that merely shows or mentions such markup, or carries data, is never mistaken for one.
 * ARCHITECTURE: pure function tests; the detected shapes have twins that must NOT be flagged (incl. the independent
 *             verifier's false-positive cases).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTextToolCall, TextToolCallError } from '@core/runtime/text-tool-call';
import { parseLlmMessage } from '@core/runtime/runtime';

const KNOWN = ['query_data', 'search_knowledge', 'delegate_to_worker'];

const CALLS: Record<string, string> = {
  'qwen/hermes (the dev incident)': '<tool_call>\n{"name": "delegate_to_worker", "arguments": {"preset": "summarise_tool_result"}}\n</tool_call>',
  'qwen xml body': '<tool_call>\n<function=search_knowledge>\n<parameter=query>\nrevenue\n</parameter>\n</function>\n</tool_call>',
  'a short lead-in, then the call (most of the reply)': 'Let me check.\n<tool_call>\n{"name": "query_data", "arguments": {"sql": "select 1"}}\n</tool_call>',
  kimi: '<|tool_calls_section_begin|><|tool_call_begin|>functions.query_data:0<|tool_call_argument_begin|>{"sql":"select 1"}<|tool_call_end|><|tool_calls_section_end|>',
  'deepseek v3': '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>query_data\n```json\n{"sql":"select 1"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  'deepseek v3.1': '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>query_data<｜tool▁sep｜>{"sql":"select 1"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  'gpt-oss harmony': '<|start|>assistant<|channel|>commentary to=functions.query_data <|constrain|>json<|message|>{"sql":"select 1"}<|call|>',
  '<|tool_call|>': '<|tool_call|>[{"name": "query_data", "arguments": {"sql": "select 1"}}]',
  mistral: '[TOOL_CALLS][{"name": "query_data", "arguments": {"sql": "select 1"}}]',
  'openai function-call json (known tool)': '{"name": "query_data", "arguments": {"sql": "select 1"}}',
  'llama parameters json, fenced (known tool)': '```json\n{"name": "query_data", "parameters": {"sql": "select 1"}}\n```',
  'type/function json': '{"type": "function", "function": {"name": "query_data", "arguments": "{\\"sql\\":\\"select 1\\"}"}}',
  'tool_calls list': '{"tool_calls": [{"type": "function", "function": {"name": "query_data", "arguments": {}}}]}',
};
for (const [name, text] of Object.entries(CALLS)) {
  test(`DETECTED: ${name}`, () => assert.ok(detectTextToolCall(text, KNOWN), text));
}

const ANSWERS: Record<string, string> = {
  prose: 'Revenue grew 12% in Q3. I checked it with query_data.',
  'markdown with a json data block': 'Here is the record:\n```json\n{"name": "Acme GmbH", "revenue": 120000}\n```',
  'a data object with name and parameters plus more fields': '{"name": "Acme", "parameters": {"tier": 1}, "revenue": 3}',
  'json list of data': '[{"name": "Acme", "city": "Berlin"}]',
  empty: '',
  // the independent verifier's false-positive cases
  'docs answer with the markup in an xml code block': 'Qwen writes its calls like this:\n```xml\n<tool_call>\n{"name": "query_data", "arguments": {}}\n</tool_call>\n```\nThe OS reads the native tool_calls field instead.',
  'prose mentioning </tool_call>': 'A Hermes-style model closes its call with </tool_call>, which our parser ignores.',
  'prose mentioning [TOOL_CALLS]': 'Mistral prefixes its calls with [TOOL_CALLS] in raw text mode.',
  'prose mentioning <|call|>': 'In harmony format a call ends with the <|call|> token.',
  'prose mentioning to=functions.lookup': 'The router addresses a tool as to=functions.lookup in harmony.',
  'prose mentioning <function=foo>': 'Qwen3-Coder uses an XML body such as <function=foo> inside its call.',
  'inline code mention': 'The model emitted `<tool_call>{"name":"x"}</tool_call>` instead of a real call.',
  'data {"name":"Acme","parameters":{"a":1}}': '{"name":"Acme","parameters":{"a":1}}',
  'data [{"name":"step1","arguments":"none"}]': '[{"name":"step1","arguments":"none"}]',
  'a long answer with one call block buried in it': `${'The analysis is complete and the figures reconcile. '.repeat(10)}<tool_call>{"name":"query_data","arguments":{}}</tool_call>`,
};
for (const [name, text] of Object.entries(ANSWERS)) {
  test(`NOT A CALL (twin): ${name}`, () => assert.equal(detectTextToolCall(text, KNOWN), null));
}

test('bare JSON counts only with a KNOWN tool name: no names known = never flagged', () => {
  assert.equal(detectTextToolCall('{"name": "query_data", "arguments": {}}'), null);
  assert.ok(detectTextToolCall('{"name": "query_data", "arguments": {}}', ['query_data']));
});

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
  assert.match(new TextToolCallError('x', 'final').message, /when asked for its final answer/);
});
