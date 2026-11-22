/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Streamed model replies — chat-completions SSE into one completion, token by token
 * USER STORY: As a user I want the answer to appear as the model writes it, and the finished
 *             answer to be exactly what a non-streamed call would have returned.
 * ARCHITECTURE: pure parser/assembler (`llm-stream.ts`); the gateway caller feeds it the response body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleStream as assemble } from '@core/runtime/llm-stream';
import { parseLlmMessage, parseLlmUsage } from '@core/runtime/runtime';

const assembleStream = (b: ReadableStream<Uint8Array>, onToken?: (t: string) => void) => assemble(b, { message: parseLlmMessage, usage: parseLlmUsage }, onToken);

const sse = (...objs: unknown[]) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`);
const body = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });

test('content deltas are emitted as they arrive and joined into the completion; usage and finish reason are kept', async () => {
  const tokens: string[] = [];
  const out = await assembleStream(body(sse(
    { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    '[DONE]',
  )), (t) => tokens.push(t));
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.equal(out.content, 'Hello');
  assert.equal(out.finishReason, 'stop');
  assert.deepEqual(out.usage, { input: 10, output: 2, total: 12 });
  assert.deepEqual(out.toolCalls, []);
});

test('a tool call split across chunks (and an event split across reads) is reassembled whole', async () => {
  const all = sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'who', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ami', arguments: '{"a":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ).join('');
  const cut = Math.floor(all.length / 2); // split mid-event
  const out = await assembleStream(body([all.slice(0, cut), all.slice(cut)]));
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].id, 'call_1');
  assert.equal(out.toolCalls[0].name, 'whoami');
  assert.deepEqual(out.toolCalls[0].args, { a: 1 });
});

test('harmony control tokens never reach the token callback', async () => {
  const tokens: string[] = [];
  await assembleStream(body(sse({ choices: [{ delta: { content: 'ok<|end|>' } }] }, '[DONE]')), (t) => tokens.push(t));
  assert.deepEqual(tokens, ['ok']);
});

test('NEGATIVE TWIN: a malformed line is skipped, not turned into text; a stream with an error object throws it', async () => {
  const out = await assembleStream(body(['data: {not json}\n\n', ...sse({ choices: [{ delta: { content: 'x' } }] }, '[DONE]')]));
  assert.equal(out.content, 'x');
  await assert.rejects(assembleStream(body(sse({ error: { message: 'budget spent' } }))), /budget spent/);
});
