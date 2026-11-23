/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    An agent runs on ONE model, with no strong→worker hand-off; a tool call written as text is never the answer
 * USER STORY: As the owner I want each agent of a system to run on exactly one model (no `delegate_to_worker`, no
 *             `escalate_to_strong`, whatever the chat's lead switch says), and I never want a tool call the model wrote
 *             as text (`<tool_call>{…}</tool_call>`, dev 23 Nov 2026) presented as my agent's answer.
 * ARCHITECTURE: the REAL graph engine (`runGraphEngine`) with a scripted model and a spy executor. `deps.nodeModel` is the
 *             one model per node (production: `agentRunModel` in `agentic-graph-server.ts`); without it the engine keeps
 *             the legacy classifier (the parity goldens pin that).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { LlmCall, LlmCompletion, LlmRequest, ToolSpec } from '@core/runtime/agentic';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { engineToolNames } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { SHAPE_SINGLE_READ_YAML } from '@tabs/agents/lib/engine/parity-harness';
import { TEXT_TOOL_CALL_PROMPT } from '@core/runtime/text-tool-call';
import { parseLlmMessage } from '@core/runtime/runtime';

const STRONG = 'strong-m';
const WORKER = 'worker-m';
const SPEC: ToolSpec = { name: 'search_knowledge', description: 'search', inputSchema: { type: 'object', properties: {} } };
type Seen = { model: string; tools: string[]; purpose: string; last: string };
type Reply = Partial<LlmCompletion> & { content: string };

function run(acts: Reply[], extra: Partial<GraphDeps> = {}) {
  const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
  const executed: string[] = [];
  const seen: Seen[] = [];
  let a = 0;
  const llm: LlmCall = async (req: LlmRequest) => {
    seen.push({ model: req.model, tools: (req.tools ?? []).map((t) => t.function.name), purpose: req.tools ? 'act' : 'plan', last: String(req.messages.at(-1)?.content ?? '') });
    if (!req.tools) return { content: '1. read', toolCalls: [] };
    const r = acts[Math.min(a++, acts.length - 1)];
    return { toolCalls: [], ...r };
  };
  const deps: Omit<GraphDeps, 'checkpointer'> = {
    llm,
    toolSpecsFor: (node) => node.tools.map(() => SPEC),
    callTool: async (tool) => { executed.push(tool); return { text: JSON.stringify({ ran: tool }), isError: false }; },
    preamble: 'RULES',
    reasoningModel: STRONG,
    execModel: WORKER,
    maxIterations: 4,
    ...extra,
  };
  return runGraphEngine({ ir: compile(sys), deps, messages: [{ role: 'user', content: 'Do the task.' }], runId: `one-model-${Math.random()}`, checkpointer: memoryCheckpointer() }).then((result) => ({ result, executed, seen }));
}
const FINAL: Reply = { content: 'all done' };
const READ: Reply = { content: '', toolCalls: [{ id: 'r', name: 'search_knowledge', args: {} }] };
const ONE_MODEL: Partial<GraphDeps> = { nodeModel: () => ({ model: STRONG, tier: 'reasoning', reason: 'agent systems run on the strong model' }) };
const stepsOf = (r: Awaited<ReturnType<typeof run>>) => r.result.runs.flatMap((n) => n.result.steps);
/** The dev incident's reply: the strong model wrote its delegate call into the reply text. */
const TEXT_CALL: Reply = { content: '<tool_call>\n{"name": "delegate_to_worker", "arguments": {"preset": "summarise_tool_result", "input_refs": ["last"]}}\n</tool_call>' };

test('NO nodeModel (legacy, the parity goldens): the engine routes by the tool classifier exactly as before', async () => {
  const r = await run([READ, FINAL]);
  assert.ok(r.seen.filter((s) => s.purpose === 'act').every((s) => s.model === WORKER));
  assert.ok(r.seen.every((s) => !s.tools.includes('delegate_to_worker') && !s.tools.includes('escalate_to_strong')));
});

test('ONE MODEL: plan, every act step and the record use the node\'s one model; no lead tool is offered', async () => {
  const r = await run([READ, FINAL], ONE_MODEL);
  assert.deepEqual([...new Set(r.seen.map((s) => s.model))], [STRONG]);
  assert.ok(r.seen.every((s) => !s.tools.includes('delegate_to_worker') && !s.tools.includes('escalate_to_strong')));
  assert.equal(r.result.runs[0].model, STRONG);
  assert.equal(r.result.finalText, 'all done');
});

test('ONE MODEL, the worker: a node resolved to the worker plans and acts on the worker only (never escalates)', async () => {
  const r = await run([READ, { content: '' }, { content: '' }], { nodeModel: () => ({ model: WORKER, tier: 'fast', reason: 'x' }) });
  assert.deepEqual([...new Set(r.seen.map((s) => s.model))], [WORKER]);
  assert.ok(r.result.failed, 'an empty worker reply fails the node (nudged once) instead of escalating');
});

test('a delegate_to_worker call is never run by the engine: not offered, and a native call to it is the typed not-found', async () => {
  const r = await run([{ content: '', toolCalls: [{ id: 'd', name: 'delegate_to_worker', args: {} }] }, FINAL], ONE_MODEL);
  assert.deepEqual(r.executed, [], 'nothing reached the executor');
  assert.ok(stepsOf(r).find((s) => s.tool === 'delegate_to_worker')?.isError);
  assert.equal(r.result.finalText, 'all done');
});

test('engineToolNames carries no lead tool (the key never allows them)', () => {
  const names = engineToolNames(compile(parseSystem(SHAPE_SINGLE_READ_YAML)));
  assert.ok(!names.includes('delegate_to_worker') && !names.includes('escalate_to_strong'), names.join(','));
});

// ---------------------------------------------------------------- the text tool-call guard

test('TEXT TOOL CALL, recovered: the reply is not the answer, nothing runs, the model is told once, and its next proper answer is used', async () => {
  const r = await run([TEXT_CALL, FINAL], ONE_MODEL);
  assert.ok(!r.result.failed, r.result.failure?.reason);
  assert.equal(r.result.finalText, 'all done');
  assert.deepEqual(r.executed, [], 'the textual call was never parsed and run');
  const acts = r.seen.filter((s) => s.purpose === 'act');
  assert.equal(acts.length, 2);
  assert.equal(acts[1].last, TEXT_TOOL_CALL_PROMPT, 'the retry carries the corrective note');
  assert.ok(stepsOf(r).find((s) => s.isError && s.result.includes('text_tool_call')), 'the run report records the textual call');
});

test('TEXT TOOL CALL twice: the step fails with the typed error, visible in the run report, and nothing runs', async () => {
  const r = await run([TEXT_CALL, TEXT_CALL, FINAL], ONE_MODEL);
  assert.ok(r.result.failed);
  assert.match(r.result.failure?.reason ?? '', /the model wrote a tool call as text instead of calling it/);
  assert.match(r.result.finalText, /wrote a tool call as text/);
  assert.equal(r.seen.filter((s) => s.purpose === 'act').length, 2, 'asked exactly once more');
  assert.deepEqual(r.executed, []);
});

test('TEXT TOOL CALL from the gateway: parseLlmMessage records it on the RAW text (Kimi markup, whose <|…|> tokens are stripped from content), and the guard acts on it', async () => {
  const kimi = parseLlmMessage({ content: '<|tool_calls_section_begin|><|tool_call_begin|>functions.search_knowledge:0<|tool_call_argument_begin|>{"q":"x"}<|tool_call_end|><|tool_calls_section_end|>' });
  assert.equal(kimi.toolCalls.length, 0);
  assert.ok(kimi.textToolCall, 'detected before the tokens were stripped');
  const r = await run([{ ...kimi }, FINAL], ONE_MODEL);
  assert.equal(r.result.finalText, 'all done');
  assert.deepEqual(r.executed, []);
});

test('TEXT TOOL CALL twin: a normal prose answer that mentions a tool and quotes JSON data is the answer, first time', async () => {
  const prose = 'I used search_knowledge and found {"name": "Acme", "revenue": 3}. All done.';
  const r = await run([{ content: prose }], ONE_MODEL);
  assert.equal(r.result.finalText, prose);
  assert.equal(r.seen.filter((s) => s.purpose === 'act').length, 1);
});
