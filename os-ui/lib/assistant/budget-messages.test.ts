/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetMessages, runAgentic, type LlmCall, type LlmMessage, type ToolSpec } from './agentic.ts';
import { estimateTokens } from '@/lib/infra/context/context-assembler';

function tokens(ms: LlmMessage[]): number {
  return ms.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
}

test('budgetMessages leaves an already-small conversation untouched', () => {
  const ms: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];
  assert.equal(budgetMessages(ms, 10_000), ms);
});

test('budgetMessages bounds an oversized transcript to the budget', () => {
  const ms: LlmMessage[] = [
    { role: 'system', content: 'system spine' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'calling tool', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'q', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(80_000) },
    { role: 'assistant', content: 'calling again', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'q', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(80_000) },
  ];
  const budget = 2_000;
  const out = budgetMessages(ms, budget);
  assert.ok(tokens(out) <= budget, `bounded to ${budget}, got ${tokens(out)}`);
  // The pinned head (system + user) always survives.
  assert.equal(out[0].content, 'system spine');
  assert.equal(out[1].content, 'do the thing');
});

test('budgetMessages holds the ceiling even for a single huge last tool turn', () => {
  const ms: LlmMessage[] = [
    { role: 'system', content: 'spine' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'call', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'q', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(200_000) },
  ];
  const budget = 300;
  const out = budgetMessages(ms, budget);
  assert.ok(tokens(out) <= budget, `got ${tokens(out)} > ${budget}`);
});

test('budgetMessages truncates the pinned head only as a last resort', () => {
  const ms: LlmMessage[] = [
    { role: 'system', content: 's'.repeat(40_000) },
    { role: 'user', content: 'u'.repeat(40_000) },
  ];
  const budget = 1_000;
  const out = budgetMessages(ms, budget);
  assert.ok(tokens(out) <= budget);
});

// A scripted LLM that records the input size it saw on each call.
function recordingLlm(): { llm: LlmCall; seen: number[] } {
  const seen: number[] = [];
  const llm: LlmCall = async (req) => {
    seen.push(tokens(req.messages as LlmMessage[]));
    return { content: 'done', toolCalls: [] };
  };
  return { llm, seen };
}

test('runAgentic bounds every model call to the passed budget', async () => {
  const { llm, seen } = recordingLlm();
  const tools: ToolSpec[] = [
    { name: 'q', description: 'query', inputSchema: { type: 'object', properties: {} } },
  ];
  await runAgentic({
    system: 'S'.repeat(200_000), // a huge system prompt on its own
    userMessages: [{ role: 'user', content: 'go' }],
    tools,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'plan',
    actModel: 'act',
    budget: 5_000,
    maxIterations: 1,
  });
  assert.ok(seen.length >= 1);
  for (const t of seen) assert.ok(t <= 5_000, `a model call saw ${t} tokens > 5000 budget`);
});

test('runAgentic forwards maxOutputTokens to the llm request', async () => {
  let sawMax: number | undefined;
  const llm: LlmCall = async (req) => {
    sawMax = req.maxTokens;
    return { content: 'done', toolCalls: [] };
  };
  await runAgentic({
    system: 'small',
    userMessages: [{ role: 'user', content: 'go' }],
    tools: [],
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'plan',
    actModel: 'act',
    budget: 5_000,
    maxOutputTokens: 4_096,
    maxIterations: 1,
  });
  assert.equal(sawMax, 4_096);
});
