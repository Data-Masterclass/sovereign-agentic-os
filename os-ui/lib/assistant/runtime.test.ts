/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { toolsForTab } from '@/lib/mcp/server';
import { runTabAgent, parseLlmMessage, parseLlmUsage, parseHarmonyToolCall, renderAssistantText, bindToolArgs, boundExecutor } from './runtime.ts';
import type { LlmCall, ToolExecutor } from './agentic.ts';

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

test('bindToolArgs fills in an OMITTED bound arg (the commit({}) empty-args fix)', () => {
  // The model issues commit({}) with no appId; the run is scoped to one app, so the
  // bound appId is filled in server-side instead of reaching the store as an empty id.
  const b = bindToolArgs({ files: [] }, { appId: 'app_bound' });
  assert.equal(b.error, undefined);
  assert.deepEqual(b.args, { files: [], appId: 'app_bound' });
});

test('bindToolArgs fills in an EMPTY-STRING bound arg too', () => {
  const b = bindToolArgs({ appId: '' }, { appId: 'app_bound' });
  assert.equal(b.error, undefined);
  assert.equal(b.args.appId, 'app_bound');
});

test('bindToolArgs accepts a MATCHING model-supplied value (idempotent)', () => {
  const b = bindToolArgs({ appId: 'app_bound', path: 'x' }, { appId: 'app_bound' });
  assert.equal(b.error, undefined);
  assert.deepEqual(b.args, { appId: 'app_bound', path: 'x' });
});

test('bindToolArgs REJECTS a mismatched value loudly (no cross-scope write)', () => {
  const b = bindToolArgs({ appId: 'app_OTHER' }, { appId: 'app_bound' });
  assert.match(String(b.error), /scoped to appId app_bound/);
  assert.match(String(b.error), /app_OTHER/);
});

test('boundExecutor fills an empty-args call with the bound id before the governed dispatch', async () => {
  // The model calls read_app_files({}); the wrapped executor must reach the base
  // (governed) dispatch WITH the bound appId — not an empty one that 404s.
  let dispatched: Record<string, unknown> | null = null;
  const base: ToolExecutor = async (_name, args) => {
    dispatched = args;
    return { text: 'ok', isError: false };
  };
  const exec = boundExecutor(base, { appId: 'app_bound' });
  const out = await exec('read_app_files', {});
  assert.equal(out.isError, false);
  assert.deepEqual(dispatched, { appId: 'app_bound' });
});

test('boundExecutor rejects a mismatched id BEFORE the governed dispatch (no cross-app write)', async () => {
  let reached = false;
  const base: ToolExecutor = async () => {
    reached = true;
    return { text: 'ok', isError: false };
  };
  const exec = boundExecutor(base, { appId: 'app_bound' });
  const out = await exec('commit', { appId: 'app_OTHER', files: [] });
  assert.equal(out.isError, true);
  assert.match(out.text, /scoped to appId app_bound/i);
  assert.equal(reached, false); // the guard short-circuited the base executor
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

test('parseLlmUsage maps a chat-completions usage block into the harness shape', () => {
  assert.deepEqual(parseLlmUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }), {
    input: 120,
    output: 30,
    total: 150,
  });
  // A gateway that omits total_tokens: the total is derived from the parts.
  assert.deepEqual(parseLlmUsage({ prompt_tokens: 10, completion_tokens: 5 }), { input: 10, output: 5, total: 15 });
});

test('parseLlmUsage never fabricates usage from an absent/malformed block', () => {
  assert.equal(parseLlmUsage(undefined), undefined);
  assert.equal(parseLlmUsage(null), undefined);
  assert.equal(parseLlmUsage({}), undefined);
  assert.equal(parseLlmUsage({ prompt_tokens: 'not-a-number' }), undefined);
  assert.equal(parseLlmUsage('usage'), undefined);
});
