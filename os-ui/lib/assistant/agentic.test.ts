/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentic,
  parseReactAction,
  toOpenAiTools,
  ToolCallingUnsupportedError,
  type LlmCall,
  type ToolSpec,
} from './agentic.ts';

const TOOLS: ToolSpec[] = [
  {
    name: 'commit',
    description: 'Commit files to the app.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
  },
  {
    name: 'request_deploy',
    description: 'Open the Builder review gate.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
  },
];

/** A scripted LLM: returns queued completions in order; records the calls it saw. */
function scriptLlm(script: Array<{ content: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] }>) {
  const calls: { model: string; hadTools: boolean; messages: number }[] = [];
  let i = 0;
  const llm: LlmCall = async (req) => {
    calls.push({ model: req.model, hadTools: !!req.tools, messages: req.messages.length });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return { content: step.content, toolCalls: step.toolCalls ?? [] };
  };
  return { llm, calls };
}

test('toOpenAiTools wraps each ToolSpec into an OpenAI function tool', () => {
  const wire = toOpenAiTools(TOOLS);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].type, 'function');
  assert.equal(wire[0].function.name, 'commit');
  assert.deepEqual(wire[0].function.parameters, TOOLS[0].inputSchema);
});

test('parseReactAction reads a fenced JSON action, a bare action, and a final', () => {
  assert.deepEqual(parseReactAction('```json\n{"tool":"commit","args":{"appId":"a1"}}\n```'), {
    tool: 'commit',
    args: { appId: 'a1' },
  });
  assert.deepEqual(parseReactAction('sure: {"tool":"request_deploy","args":{"appId":"a1"}}'), {
    tool: 'request_deploy',
    args: { appId: 'a1' },
  });
  assert.equal(parseReactAction('All done — the preview is live.'), null);
  assert.equal(parseReactAction('{"final":"done"}'), null);
});

test('the loop PLANS with the reasoning model then ACTS with the exec model', async () => {
  const { llm, calls } = scriptLlm([
    { content: '1. Generate files\n2. commit\n3. deploy' }, // plan (no tools)
    { content: 'All committed and deploy requested.' }, // act: final immediately
  ]);
  const executed: string[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'build a todo app' }],
    tools: TOOLS,
    callTool: async (name) => {
      executed.push(name);
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'reason-x',
    actModel: 'exec-y',
  });
  assert.match(res.plan, /Generate files/);
  assert.equal(calls[0].model, 'reason-x');
  assert.equal(calls[0].hadTools, false); // planning never passes tools
  assert.equal(calls[1].model, 'exec-y');
  assert.equal(calls[1].hadTools, true); // native tool-calling passes tools
  assert.equal(res.finalText, 'All committed and deploy requested.');
  assert.equal(res.steps.length, 0);
  assert.equal(executed.length, 0);
});

test('native tool-calls are executed through the governed callTool and fed back', async () => {
  const { llm } = scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: 'commit', args: { appId: 'a1' } }] },
    { content: '', toolCalls: [{ id: 'c2', name: 'request_deploy', args: { appId: 'a1' } }] },
    { content: 'Done: committed then opened the deploy review gate.' },
  ]);
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'ship it' }],
    tools: TOOLS,
    callTool: async (name, args) => {
      executed.push({ name, args });
      return { text: `${name} ok`, isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.deepEqual(executed.map((e) => e.name), ['commit', 'request_deploy']);
  assert.deepEqual(executed[0].args, { appId: 'a1' });
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].tool, 'request_deploy');
  assert.equal(res.finalText, 'Done: committed then opened the deploy review gate.');
  assert.equal(res.toolCallingSupported, true);
});

test('the iteration cap holds — the loop stops after maxIterations tool rounds', async () => {
  // The model never emits a final; it always asks for another tool call.
  const llm: LlmCall = async () => ({
    content: '',
    toolCalls: [{ id: 'x', name: 'commit', args: { appId: 'a1' } }],
  });
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'loop forever' }],
    tools: TOOLS,
    callTool: async () => {
      executed += 1;
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 3,
  });
  assert.equal(res.iterations, 3);
  assert.equal(executed, 3);
  assert.match(res.finalText, /step limit|cap/i);
});

test('falls back to the ReAct JSON protocol when the model rejects the tools param', async () => {
  // Native attempt throws ToolCallingUnsupportedError once; then the model drives
  // via JSON actions in plain text (no tools param passed after the fallback).
  let planned = false;
  const seenTools: boolean[] = [];
  const llm: LlmCall = async (req) => {
    if (!planned && !req.tools) {
      planned = true;
      return { content: 'plan', toolCalls: [] }; // the PLAN call
    }
    seenTools.push(!!req.tools);
    if (req.tools) throw new ToolCallingUnsupportedError('model has no function-calling');
    // ReAct mode: first drive a tool, then finish (an Observation turn is a
    // user message that STARTS with "Observation:", distinct from the protocol
    // instructions in the system prompt that merely mention the word).
    if (!req.messages.some((m) => m.role === 'user' && m.content.startsWith('Observation:'))) {
      return { content: '```json\n{"tool":"commit","args":{"appId":"a1"}}\n```', toolCalls: [] };
    }
    return { content: 'All set via ReAct.', toolCalls: [] };
  };
  const executed: string[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'build' }],
    tools: TOOLS,
    callTool: async (name) => {
      executed.push(name);
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.equal(res.toolCallingSupported, false);
  assert.deepEqual(executed, ['commit']);
  assert.equal(res.finalText, 'All set via ReAct.');
});

test('displayed text is guarded — leaked <think> reasoning is stripped', async () => {
  const { llm } = scriptLlm([
    { content: '<think>secret plan</think>1. do it' },
    { content: '<think>reason</think>Final answer.' },
  ]);
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'x' }],
    tools: TOOLS,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.equal(res.plan.includes('secret plan'), false);
  assert.equal(res.finalText, 'Final answer.');
});
