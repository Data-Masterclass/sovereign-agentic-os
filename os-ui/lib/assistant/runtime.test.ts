/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { toolsForTab } from '@/lib/mcp/server';
import { runTabAgent, parseLlmMessage, parseHarmonyToolCall, renderAssistantText } from './runtime.ts';
import type { LlmCall } from './agentic.ts';

const participant: CurrentUser = { id: 'u-part', name: 'Pat', domains: ['sales'], role: 'creator' };

test('parseLlmMessage extracts content and native tool_calls (arguments JSON-decoded)', () => {
  const c = parseLlmMessage({
    content: 'ok',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commit', arguments: '{"appId":"a1"}' } }],
  });
  assert.equal(c.content, 'ok');
  assert.equal(c.toolCalls.length, 1);
  assert.deepEqual(c.toolCalls[0], { id: 'c1', name: 'commit', args: { appId: 'a1' } });
});

test('parseLlmMessage tolerates malformed tool arguments (never throws)', () => {
  const c = parseLlmMessage({ tool_calls: [{ id: 'x', function: { name: 'f', arguments: 'not json' } }] });
  assert.deepEqual(c.toolCalls[0].args, {});
});

test('parseLlmMessage strips harmony channel tokens leaked into the tool name', () => {
  // gpt-oss (harmony format) can emit `query_data<|channel|>commentary` as the
  // function name; the parser must recover the bare `query_data` and keep args.
  const c = parseLlmMessage({
    content: '',
    tool_calls: [
      {
        id: 'h1',
        type: 'function',
        function: { name: 'query_data<|channel|>commentary', arguments: '{"question":"top campaigns"}' },
      },
    ],
  });
  assert.equal(c.toolCalls.length, 1);
  assert.equal(c.toolCalls[0].name, 'query_data'); // NOT `query_data<|channel|>commentary`
  assert.deepEqual(c.toolCalls[0].args, { question: 'top campaigns' });
});

test('parseLlmMessage recovers a tool call emitted as harmony commentary TEXT', () => {
  // No structured tool_calls — the model wrote the call in the commentary channel.
  const content =
    '<|start|>assistant<|channel|>commentary to=query_data<|message|>{"question":"revenue by month"}<|call|>';
  const c = parseLlmMessage({ content });
  assert.equal(c.toolCalls.length, 1);
  assert.equal(c.toolCalls[0].name, 'query_data');
  assert.deepEqual(c.toolCalls[0].args, { question: 'revenue by month' });
});

test('parseHarmonyToolCall returns null for plain final-answer text (no false calls)', () => {
  assert.equal(parseHarmonyToolCall('Here is your final summary of the campaign performance.'), null);
});

test('the deploy path is a GATE, not an ungoverned deploy', () => {
  const names = toolsForTab('software').map((t) => t.name);
  // request_deploy opens the review card; decide_deploy is the only go-live and
  // is Builder-gated. There is NO ungoverned "deploy" tool on the surface.
  assert.ok(names.includes('request_deploy'));
  assert.ok(names.includes('decide_deploy'));
  assert.equal(names.includes('deploy'), false);
  const decide = toolsForTab('software').find((t) => t.name === 'decide_deploy')!;
  assert.equal(decide.minRole, 'builder');
});

test('a tool call routes through the governed dispatch (read-only, participant-visible)', async () => {
  // The model asks for the Agents read-only inventory; the harness must execute it
  // via the governed function and feed the result back into a final answer.
  const llm = actThenFinish([{ id: 'a', name: 'list_agent_systems', args: {} }], 'Listed your agent systems.');
  const res = await runTabAgent({ user: participant, tab: 'agents', messages: [{ role: 'user', content: 'what agents do I have?' }], llm });
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].tool, 'list_agent_systems');
  assert.equal(res.steps[0].isError, false); // governed call succeeded under the participant identity
  assert.equal(res.finalText, 'Listed your agent systems.');
});

test('a Builder-only tool is role-gated for a participant (surfaced as a tool error)', async () => {
  // decide_deploy needs Builder+. The governed dispatch must reject it for a
  // participant — the harness surfaces that as an isError step, not a silent pass.
  const llm = actThenFinish(
    [{ id: 'd', name: 'decide_deploy', args: { cardId: 'x', decision: 'approve' } }],
    'I could not approve the deploy.',
  );
  const res = await runTabAgent({ user: participant, tab: 'software', messages: [{ role: 'user', content: 'approve the deploy' }], llm });
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].tool, 'decide_deploy');
  assert.equal(res.steps[0].isError, true);
});

test('renderAssistantText assembles plan → actions → result for the chat UI', () => {
  const text = renderAssistantText({
    plan: '1. do it',
    steps: [{ tool: 'commit', args: {}, result: 'committed', isError: false }],
    finalText: 'Done.',
    iterations: 1,
    toolCallingSupported: true,
  });
  assert.match(text, /### Plan/);
  assert.match(text, /### Actions/);
  assert.match(text, /`commit`/);
  assert.match(text, /### Result[\s\S]*Done\./);
});

/**
 * A scripted LLM that PLANS (no tools), then on the ACT call issues the given
 * tool_calls once, then returns a final answer. Mirrors native function-calling.
 */
function actThenFinish(
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[],
  finalText: string,
): LlmCall {
  let acted = false;
  return async (req) => {
    if (!req.tools) return { content: '1. plan', toolCalls: [] }; // PLAN turn
    if (!acted) {
      acted = true;
      return { content: '', toolCalls };
    }
    return { content: finalText, toolCalls: [] };
  };
}
