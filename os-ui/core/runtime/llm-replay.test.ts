/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    Tests for the record / replay model caller
 * USER STORY: As the engine-rebuild engineer I want proof that a recording captures model +
 *             tool-set + response, that replay serves responses in order, and that it fails
 *             loudly (naming the request) on exhaustion or a model/tool-set mismatch.
 * ARCHITECTURE:
 *   - Pure unit tests; a tiny scripted inner caller stands in for LiteLLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import {
  describeRequest,
  recordingCaller,
  replayCaller,
  ReplayExhaustedError,
  ReplayMismatchError,
  type RecordedExchange,
} from '@core/runtime/llm-replay';

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: { type: 'object' as const, properties: {} } } });

const req = (model: string, tools?: string[]): LlmRequest => ({
  model,
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  tools: tools?.map(tool),
});

test('describeRequest keeps model, sorted unique tool names and the message count only', () => {
  const d = describeRequest(req('m', ['b', 'a', 'b']));
  assert.deepEqual(d, { model: 'm', tools: ['a', 'b'], messages: 2 });
  assert.deepEqual(describeRequest(req('m')).tools, []);
});

test('recordingCaller forwards to the inner caller and records each exchange after it resolves', async () => {
  const inner: LlmCall = async (r) => ({ content: `reply to ${r.model}`, toolCalls: [] });
  const sink: RecordedExchange[] = [];
  const llm = recordingCaller(inner, sink);
  const out = await llm(req('plan-model'));
  await llm(req('act-model', ['search_knowledge']));
  assert.equal(out.content, 'reply to plan-model');
  assert.equal(sink.length, 2);
  assert.deepEqual(sink[1].request, { model: 'act-model', tools: ['search_knowledge'], messages: 2 });
  assert.equal(sink[1].response.content, 'reply to act-model');
  // The record is a copy: mutating the returned completion does not alter the transcript.
  out.content = 'mutated';
  assert.equal(sink[0].response.content, 'reply to plan-model');
});

test('recordingCaller accepts a callback sink and records nothing when the inner call rejects', async () => {
  const seen: RecordedExchange[] = [];
  const failing = recordingCaller(async () => { throw new Error('boom'); }, (ex) => { seen.push(ex); });
  await assert.rejects(failing(req('m')), /boom/);
  assert.equal(seen.length, 0);
});

test('replayCaller serves responses in order and reports consumed/remaining', async () => {
  const transcript: RecordedExchange[] = [
    { request: { model: 'p', tools: [], messages: 2 }, response: { content: 'plan', toolCalls: [] } },
    { request: { model: 'a', tools: ['q'], messages: 2 }, response: { content: '', toolCalls: [{ id: 'c1', name: 'q', args: { x: 1 } }] } },
  ];
  const llm = replayCaller({ version: 1, exchanges: transcript });
  assert.equal(llm.remaining(), 2);
  const first = await llm(req('p'));
  assert.equal(first.content, 'plan');
  const second = await llm(req('a', ['q']));
  assert.deepEqual(second.toolCalls, [{ id: 'c1', name: 'q', args: { x: 1 } }]);
  assert.equal(llm.consumed(), 2);
  assert.equal(llm.remaining(), 0);
  // Served responses are copies — a consumer mutating one cannot corrupt the fixture.
  second.toolCalls[0].args.x = 99;
  assert.equal((transcript[1].response.toolCalls[0].args as { x: number }).x, 1);
});

test('replayCaller fails loudly when the transcript runs out, naming the request', async () => {
  const llm = replayCaller([{ request: { model: 'p', tools: [], messages: 1 }, response: { content: 'x', toolCalls: [] } }]);
  await llm(req('p'));
  await assert.rejects(llm(req('p')), (e: unknown) => {
    assert.ok(e instanceof ReplayExhaustedError);
    assert.match(e.message, /request #2/);
    assert.match(e.message, /model 'p'/);
    return true;
  });
});

test('replayCaller fails loudly on a model mismatch and on a tool-set mismatch, naming both sides', async () => {
  const mk = () => replayCaller([{ request: { model: 'act', tools: ['a', 'b'], messages: 1 }, response: { content: 'x', toolCalls: [] } }]);
  await assert.rejects(mk()(req('other', ['a', 'b'])), (e: unknown) => {
    assert.ok(e instanceof ReplayMismatchError);
    assert.match(e.message, /expected model 'act' tools \[a, b\]/);
    assert.match(e.message, /got model 'other'/);
    return true;
  });
  await assert.rejects(mk()(req('act', ['a'])), (e: unknown) => {
    assert.ok(e instanceof ReplayMismatchError);
    assert.equal(e.index, 0);
    assert.deepEqual(e.actual.tools, ['a']);
    return true;
  });
  // Tool ORDER on the wire never matters — the recording is name-sorted.
  const ok = await mk()(req('act', ['b', 'a']));
  assert.equal(ok.content, 'x');
});
