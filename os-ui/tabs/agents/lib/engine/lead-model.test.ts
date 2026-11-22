/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The agent engine follows the OS-wide lead switch: strong leads and delegates, or the worker leads and escalates
 * USER STORY: As the owner I want "strong leads, workers are sub-agents" (and the "Save costs" switch) to apply to agent
 *             runs too, not only to the chat.
 * ARCHITECTURE: the REAL graph engine (`runGraphEngine`) with a scripted model and a spy executor. `deps.lead` is the one
 *             new input; without it the engine behaves exactly as before (the parity goldens pin that).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { LlmCall, LlmRequest, ToolSpec } from '@core/runtime/agentic';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { SHAPE_SINGLE_READ_YAML } from '@tabs/agents/lib/engine/parity-harness';

const STRONG = 'strong-m';
const WORKER = 'worker-m';
const SPEC: ToolSpec = { name: 'search_knowledge', description: 'search', inputSchema: { type: 'object', properties: {} } };
type Seen = { model: string; tools: string[]; purpose: string };
type Reply = { content: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; refusal?: string };

function run(acts: Reply[], lead?: GraphDeps['lead'], seen: Seen[] = []) {
  const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
  const executed: string[] = [];
  let a = 0;
  const llm: LlmCall = async (req: LlmRequest) => {
    seen.push({ model: req.model, tools: (req.tools ?? []).map((t) => t.function.name), purpose: req.tools ? 'act' : 'plan' });
    if (!req.tools) return { content: '1. read', toolCalls: [] };
    const r = acts[Math.min(a++, acts.length - 1)];
    return { content: r.content, toolCalls: r.toolCalls ?? [], ...(r.refusal ? { refusal: r.refusal } : {}) };
  };
  const deps: Omit<GraphDeps, 'checkpointer'> = {
    llm,
    toolSpecsFor: (node) => node.tools.map(() => SPEC),
    callTool: async (tool) => { executed.push(tool); return { text: JSON.stringify({ ran: tool }), isError: false }; },
    preamble: 'RULES',
    reasoningModel: STRONG,
    execModel: WORKER,
    maxIterations: 4,
    ...(lead ? { lead } : {}),
  };
  return runGraphEngine({ ir: compile(sys), deps, messages: [{ role: 'user', content: 'Do the task.' }], runId: `lead-${Math.random()}`, checkpointer: memoryCheckpointer() }).then((result) => ({ result, executed, seen }));
}
const FINAL: Reply = { content: 'all done' };
const READ: Reply = { content: '', toolCalls: [{ id: 'r', name: 'search_knowledge', args: {} }] };
const stepsOf = (r: Awaited<ReturnType<typeof run>>) => r.result.runs.flatMap((n) => n.result.steps);

test('NO LEAD SWITCH wired: the engine routes by the tool classifier exactly as before (a read-only node runs on the worker)', async () => {
  const r = await run([READ, FINAL]);
  assert.ok(r.seen.filter((s) => s.purpose === 'act').every((s) => s.model === WORKER));
  assert.ok(r.seen.every((s) => !s.tools.includes('delegate_to_worker') && !s.tools.includes('escalate_to_strong')));
});

test('STRONG LEADS: plan and act run on the strong model, and the node is offered delegate_to_worker (not escalate_to_strong)', async () => {
  const r = await run([READ, FINAL], { mode: 'strong', delegate: async () => ({ text: '{}', isError: false }) });
  assert.ok(r.seen.every((s) => s.model === STRONG), JSON.stringify(r.seen.map((s) => s.model)));
  assert.ok(r.seen.filter((s) => s.purpose === 'act').every((s) => s.tools.includes('delegate_to_worker') && !s.tools.includes('escalate_to_strong')));
});

test('STRONG LEADS: a delegate_to_worker call goes to the delegation hook with this node\'s earlier results, and its result is fed back', async () => {
  let got: { args: Record<string, unknown>; results: { tool: string; text: string }[] } | null = null;
  const r = await run(
    [READ, { content: '', toolCalls: [{ id: 'd', name: 'delegate_to_worker', args: { preset: 'summarise_tool_result', input_refs: ['last'] } }] }, FINAL],
    { mode: 'strong', delegate: async (args, ctx) => { got = { args, results: ctx.results }; return { text: '{"delegated":true}', isError: false }; } },
  );
  assert.ok(got, 'the hook ran');
  assert.equal((got as { results: { tool: string }[] }).results[0].tool, 'search_knowledge');
  assert.ok(stepsOf(r).some((s) => s.tool === 'delegate_to_worker' && s.result.includes('delegated')));
  assert.deepEqual(r.executed, ['search_knowledge'], 'the delegation never reached the governed executor');
});

test('STRONG LEADS twin: with no delegation hook the tool is not offered, and a call to it is refused', async () => {
  const r = await run([{ content: '', toolCalls: [{ id: 'd', name: 'delegate_to_worker', args: {} }] }, FINAL], { mode: 'strong' });
  assert.ok(r.seen.every((s) => !s.tools.includes('delegate_to_worker')));
  assert.deepEqual(r.executed, []);
});

test('WORKER LEADS: plan and act run on the worker; the node is offered escalate_to_strong (not delegate_to_worker)', async () => {
  const r = await run([READ, FINAL], { mode: 'worker' });
  assert.ok(r.seen.every((s) => s.model === WORKER));
  assert.ok(r.seen.filter((s) => s.purpose === 'act').every((s) => s.tools.includes('escalate_to_strong') && !s.tools.includes('delegate_to_worker')));
});

test('WORKER LEADS: escalate_to_strong hands the node to the strong model for the rest of its visit, once, and is recorded as a step', async () => {
  const r = await run([READ, { content: '', toolCalls: [{ id: 'e', name: 'escalate_to_strong', args: { reason: 'needs judgement' } }] }, FINAL], { mode: 'worker' });
  const acts = r.seen.filter((s) => s.purpose === 'act').map((s) => s.model);
  assert.deepEqual(acts, [WORKER, WORKER, STRONG]);
  const esc = stepsOf(r).find((s) => s.tool === 'escalate_to_strong');
  assert.ok(esc && !esc.isError && /needs judgement/.test(JSON.stringify(esc.args)));
  assert.deepEqual(r.executed, ['search_knowledge']);
});

test('WORKER LEADS: an EMPTY worker reply escalates to strong at once (no nudge round on the worker)', async () => {
  const r = await run([{ content: '  ' }, FINAL], { mode: 'worker' });
  assert.deepEqual(r.seen.filter((s) => s.purpose === 'act').map((s) => s.model), [WORKER, STRONG]);
  assert.equal(r.result.reachedEnd, true);
});

test('WORKER LEADS: a REFUSAL escalates to strong instead of failing the node', async () => {
  const r = await run([{ content: '', refusal: 'cannot help' }, FINAL], { mode: 'worker' });
  assert.deepEqual(r.seen.filter((s) => s.purpose === 'act').map((s) => s.model), [WORKER, STRONG]);
  assert.equal(r.result.reachedEnd, true);
});

test('WORKER LEADS twin: a normal worker answer never touches strong', async () => {
  const r = await run([READ, FINAL], { mode: 'worker' });
  assert.ok(!r.seen.some((s) => s.model === STRONG));
});

test('STRONG LEADS twin: a refusal still fails the node as before (there is nobody above strong to escalate to)', async () => {
  const r = await run([{ content: '', refusal: 'cannot help' }], { mode: 'strong', delegate: async () => ({ text: '{}', isError: false }) });
  assert.equal(r.result.reachedEnd, false);
  assert.ok(r.seen.filter((s) => s.purpose === 'act').every((s) => s.model === STRONG));
});
