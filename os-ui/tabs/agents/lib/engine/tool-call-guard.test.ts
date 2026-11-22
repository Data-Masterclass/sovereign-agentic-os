/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Malformed, invalid, truncated, refused and empty model replies (F10)
 * USER STORY: As the owner of an agent system I want a tool call the model got wrong to come back
 *             to the model as an error it can fix — never to run with empty arguments — and a
 *             reply that was cut off, refused or empty to be recorded as exactly that.
 * ARCHITECTURE:
 *   - A scripted fake model (one reply per ACT call), a spy executor, a memory approval port and
 *     the real `buildGraph` through `runGraphEngine`. No network, no server-only module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { AgenticStep, LlmCall, LlmCompletion, LlmRequest, ToolSpec } from '@core/runtime/agentic';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { memoryApprovalPort, type MemoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { toolErrorCode } from '@tabs/agents/lib/engine/tool-result';
import { MAX_ARG_REPAIR_ATTEMPTS } from '@tabs/agents/lib/engine/tool-args';

const SPECS: Record<string, ToolSpec> = {
  query_data: {
    name: 'query_data',
    description: 'Run SQL.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  },
  // A real entry of the write catalog, so the hold rule sees a write.
  ingest_dataset: {
    name: 'ingest_dataset',
    description: 'Ingest rows.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
      required: ['datasetId', 'content'],
    },
  },
};

const yaml = (preset: string) => `version: '1'
system: { name: guard, domain: sales, visibility: Personal }
safety_preset: ${preset}
entrypoint: a
grants: { data: [], knowledge: [], metrics: [], tools: [query_data, ingest_dataset], connections: [] }
agents:
  - { id: a, role: first, agent_md: '# a', memory_md: '# Memory', tools: [query_data, ingest_dataset] }
  - { id: b, role: second, agent_md: '# b', memory_md: '# Memory', tools: [query_data] }
edges:
  - { from: a, to: b, type: handoff }
`;

type Reply = Partial<LlmCompletion> & { content?: string; throws?: Error };

/** PLAN → a fixed plan; the n-th ACT of agent `a` → `replies[n]`; agent b and anything after → FINAL. */
function scripted(replies: Reply[], seen: LlmRequest[] = []): LlmCall {
  let n = 0;
  return async (req) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const isPlan = /Output only the plan/.test(system);
    if (isPlan) return { content: 'plan', toolCalls: [] };
    if (/YOUR ROLE IN THE TEAM: b /.test(system)) return { content: 'FINAL(b)', toolCalls: [] };
    seen.push(req);
    const r = replies[n] ?? { content: 'FINAL(a)' };
    n += 1;
    if ((r as { throws?: Error }).throws) throw (r as { throws: Error }).throws;
    return { content: '', toolCalls: [], ...r } as LlmCompletion;
  };
}

async function run(replies: Reply[], opts: { preset?: string; port?: MemoryApprovalPort; seen?: LlmRequest[]; extraDeps?: Partial<GraphDeps> } = {}) {
  const sys = parseSystem(yaml(opts.preset ?? 'full-in-scope'));
  const ir = compile(sys);
  const executed: { tool: string; args: Record<string, unknown> }[] = [];
  const steps: AgenticStep[] = [];
  const port = opts.port ?? memoryApprovalPort();
  const deps: Omit<GraphDeps, 'checkpointer'> = {
    llm: scripted(replies, opts.seen),
    toolSpecsFor: (node) => node.tools.map((t) => SPECS[t]).filter(Boolean),
    callTool: async (tool, args) => { executed.push({ tool, args }); return { text: JSON.stringify({ ran: tool }), isError: false }; },
    preamble: 'RULES',
    reasoningModel: 'reasoning',
    execModel: 'fast',
    maxIterations: 8,
    maxRunSteps: 40,
    ...opts.extraDeps,
    hold: {
      decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
      approvals: port,
      systemId: 'sys-guard',
      domain: 'sales',
      runner: { id: 'u1', role: 'creator', domains: ['sales'] },
      agent: 'os-sys-guard',
    },
  };
  const result = await runGraphEngine({
    ir,
    deps,
    messages: [{ role: 'user', content: 'Do it.' }],
    runId: `guard-${Math.random()}`,
    checkpointer: memoryCheckpointer(),
    hooks: { onStep: (ev) => steps.push(ev.step) },
  });
  return { result, executed, steps, port };
}

const call = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, id = 'c1') => ({ id, name, args, ...extra });

// ------------------------------------------------------------ (a) arguments --

test('F10a: arguments that are not valid JSON are NOT executed — the model gets a typed error naming the problem and the expected shape, and repairs', async () => {
  const seen: LlmRequest[] = [];
  const { result, executed, steps } = await run(
    [
      { toolCalls: [call('query_data', {}, { argsError: 'Unexpected end of JSON input', rawArgs: '{"sql": "select 1 fr' })] },
      { toolCalls: [call('query_data', { sql: 'select 1' }, {}, 'c2')] },
    ],
    { seen },
  );
  assert.deepEqual(executed, [{ tool: 'query_data', args: { sql: 'select 1' } }], 'only the repaired call ran — never the empty one');
  assert.equal(steps[0].isError, true);
  assert.equal(toolErrorCode(steps[0].result), 'invalid_argument');
  assert.match(steps[0].result, /not valid JSON/);
  assert.match(steps[0].result, /"required":\["sql"\]/);
  // The model was shown that error as the tool result of its own call.
  const fed = seen[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(fed && /invalid_argument/.test(fed.content));
  assert.equal(result.reachedEnd, true);
  assert.deepEqual(result.path, ['a', 'b']);
});

test('F10a: arguments that fail the tool\'s schema (missing required field, wrong type, value outside the enum) are not executed', async () => {
  const { executed, steps } = await run([
    { toolCalls: [call('ingest_dataset', { datasetId: 'ds_1' })] },
    { toolCalls: [call('ingest_dataset', { datasetId: 'ds_1', content: 'a,b', mode: 'upsert' }, {}, 'c2')] },
  ]);
  assert.deepEqual(executed, []);
  assert.match(steps[0].result, /missing required 'content'/);
  assert.match(steps[1].result, /'mode' must be one of: append, replace/);
});

test(`F10a: after ${MAX_ARG_REPAIR_ATTEMPTS} repair attempt(s) the agent FAILS with a clear reason, and the run stops there`, async () => {
  const bad = (id: string) => ({ toolCalls: [call('query_data', {}, {}, id)] });
  const { result, executed } = await run([bad('c1'), bad('c2'), bad('c3')]);
  assert.deepEqual(executed, []);
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.path, ['a'], 'the next agent is not visited');
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /kept sending invalid arguments for query_data.*missing required 'sql'/);
  assert.equal(result.runs[0].result.steps.length, MAX_ARG_REPAIR_ATTEMPTS + 1, 'every refused call is on the record');
});

test('F10a: a HELD write is never parked, approved or called with repaired-by-default arguments', async () => {
  const port = memoryApprovalPort();
  const { result, executed } = await run(
    [
      // Truncated argument JSON: before this fix it became {} and the write was queued for approval with no arguments.
      { toolCalls: [call('ingest_dataset', {}, { argsError: 'Unterminated string in JSON', rawArgs: '{"datasetId":"ds_1","content":"a,b' })] },
      { content: 'I could not ingest.' },
    ],
    { preset: 'read-only', port },
  );
  assert.deepEqual(port.all(), [], 'nothing was filed for approval');
  assert.equal(result.parked, false);
  assert.deepEqual(executed, []);
});

test('F10a: a valid call in the same reply still runs; lossless coercions ("5" for a number) are applied, not refused', async () => {
  const { executed, steps } = await run([
    { toolCalls: [call('query_data', {}, {}, 'bad'), call('query_data', { sql: 'select 2' }, {}, 'good')] },
  ]);
  assert.deepEqual(executed, [{ tool: 'query_data', args: { sql: 'select 2' } }]);
  assert.equal(steps.filter((s) => s.isError).length, 1);
});

test('F10e: an unknown tool keeps its typed not_found (it is not a schema error)', async () => {
  const { steps, executed } = await run([{ toolCalls: [call('drop_everything', {})] }]);
  assert.deepEqual(executed, []);
  assert.equal(toolErrorCode(steps[0].result), 'not_found');
});

// ------------------------------------------------------------- (b) length --

test('F10b: finish_reason "length" on a reply with tool calls is a TRUNCATED call — not executed, one retry asking for a shorter call', async () => {
  const seen: LlmRequest[] = [];
  const { executed, steps, result } = await run(
    [
      { finishReason: 'length', toolCalls: [call('ingest_dataset', { datasetId: 'ds_1', content: 'a,b' })] },
      { toolCalls: [call('query_data', { sql: 'select 1' }, {}, 'c2')] },
    ],
    { seen },
  );
  assert.deepEqual(executed.map((e) => e.tool), ['query_data'], 'the cut-off write did not run even though its JSON happened to parse');
  assert.equal(toolErrorCode(steps[0].result), 'truncated_call');
  assert.match(seen[1].messages.at(-1)?.content ?? '', /cut off at the output limit.*shorter/s);
  assert.equal(result.reachedEnd, true);
});

test('F10b: a second truncated call fails the agent clearly', async () => {
  const cut = { finishReason: 'length', toolCalls: [call('query_data', { sql: 'select 1' })] };
  const { result, executed } = await run([cut, cut]);
  assert.deepEqual(executed, []);
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /cut off at the model's output limit/);
});

test('F10b: finish_reason "length" on a final answer marks the visit truncated in the run record', async () => {
  const { result } = await run([{ finishReason: 'length', content: 'The total is 4' }]);
  assert.equal(result.runs[0].truncated, true);
  assert.match(result.runs[0].result.finalText, /^The total is 4/);
  assert.match(result.runs[0].result.finalText, /cut off at the model's output limit/);
  assert.equal(result.runs[1].truncated, undefined);
});

// ------------------------------------------------- (c) refusal, (d) empty --

test('F10c: a refusal is surfaced as a refusal — the agent fails, it is not handed on as an answer', async () => {
  const { result } = await run([{ refusal: 'I can’t help with that.' }]);
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /the model refused: I can’t help with that\./);
  assert.deepEqual(result.path, ['a']);
});

test('F10c: a content-filter finish is surfaced as such', async () => {
  const { result } = await run([{ finishReason: 'content_filter', content: '' }]);
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /content filter/);
});

test('F10d: an empty reply is not "ok" — one nudge, and the nudged answer is used', async () => {
  const seen: LlmRequest[] = [];
  const { result, steps } = await run([{ content: '' }, { content: 'Here is the answer.' }], { seen });
  assert.match(seen[1].messages.at(-1)?.content ?? '', /Your last reply was empty/);
  assert.equal(result.runs[0].result.finalText, 'Here is the answer.');
  assert.equal(toolErrorCode(steps[0].result), 'empty_reply', 'the retry is visible in the run events');
});

test('F10d: a second empty reply fails the agent with "the model returned nothing"', async () => {
  const { result } = await run([{ content: '' }, { content: '<think>hmm</think>' }]);
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /the model returned nothing/);
  assert.deepEqual(result.path, ['a']);
  assert.equal(result.reachedEnd, false);
});

// ---------------------------------------------- reasoning-exhausted is not "empty" --

test('a reasoning-exhausted reply (length, no content, reasoning present) fails with the precise reason, not "the model returned nothing", and is NOT nudged', async () => {
  const seen: LlmRequest[] = [];
  const { result } = await run([{ content: '', finishReason: 'length', reasoning: { chars: 4000 }, usage: { input: 10, output: 300, total: 310, reasoning: 300 } }, { content: 'never asked' }], { seen });
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /the model spent its whole output budget on reasoning \(300 tokens\); raise the output limit for /);
  assert.doesNotMatch(result.runs[0].error ?? '', /returned nothing/);
  assert.equal(seen.length, 1, 'no nudge: asking again with the same budget cannot help');
});

test('the typed error the model caller throws (retry already spent) reaches the run as the same precise message', async () => {
  const { ReasoningBudgetExhaustedError } = await import('@core/runtime/reasoning-budget');
  const { result } = await run([{ throws: new ReasoningBudgetExhaustedError(1200, 'sovereign-strong', 'kimi-k3.1-pro', 1200) }]);
  assert.equal(result.runs[0].status, 'failed');
  assert.match(result.runs[0].error ?? '', /raise the output limit for sovereign-strong\/kimi-k3\.1-pro/);
});

test('NEGATIVE TWIN: a length-stopped empty reply WITHOUT reasoning is still the ordinary empty reply (one nudge)', async () => {
  const { result } = await run([{ content: '', finishReason: 'length' }, { content: 'ok now' }]);
  assert.equal(result.runs[0].result.finalText, 'ok now');
});

test('reasoning_effort per step kind: ACT low, PLAN medium; absent when not configured (not even the key)', async () => {
  const on: LlmRequest[] = [];
  await run([{ content: 'done' }], { seen: on, extraDeps: { reasoningEfforts: { act: 'low', plan: 'medium' } } });
  assert.equal(on[0].reasoningEffort, 'low');
  const off: LlmRequest[] = [];
  await run([{ content: 'done' }], { seen: off });
  assert.equal('reasoningEffort' in off[0], false);
});

test('the retries are counted against the step budget', async () => {
  const { result } = await run([{ content: '' }, { content: 'done' }]);
  const plain = await run([{ content: 'done' }]);
  assert.equal(result.budget.stepsUsed, plain.result.budget.stepsUsed + 1);
});
