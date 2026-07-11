/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { listToolsForRole, toolsForTab } from '@/lib/mcp/server';
import { SOFTWARE_TEAM_YAML } from '../software-team.ts';
import { nodeOrder, runAgenticGraph, type AgenticGraphDeps } from './agentic-graph.ts';
import type { LlmCall, LlmCompletion, ToolExecutor, ToolSpec } from '@/lib/assistant/agentic';

const IR = compile(parseSystem(SOFTWARE_TEAM_YAML));

/**
 * A scripted LLM keyed by ACT model: the PLAN call (no tools) always returns a
 * short plan; an ACT call returns whatever the script says for that model. This
 * lets us assert per-node model routing AND drive tool calls deterministically.
 */
function scriptLlm(actByModel: Record<string, LlmCompletion | LlmCompletion[]>) {
  const seen: { model: string; hadTools: boolean }[] = [];
  // Per-model ACT queues: consumed one completion per ACT call, last one repeats.
  const queues = new Map<string, LlmCompletion[]>();
  for (const [m, v] of Object.entries(actByModel)) queues.set(m, Array.isArray(v) ? [...v] : [v]);
  const llm: LlmCall = async (req) => {
    seen.push({ model: req.model, hadTools: !!req.tools });
    // The PLAN step carries no tools; return a plan and stop it acting.
    if (!req.tools) return { content: 'plan: do the thing', toolCalls: [] };
    const q = queues.get(req.model);
    if (q && q.length > 0) return q.length > 1 ? q.shift()! : q[0];
    return { content: `done (${req.model})`, toolCalls: [] };
  };
  return { llm, seen };
}

function baseDeps(over: Partial<AgenticGraphDeps> = {}): AgenticGraphDeps {
  return {
    llm: scriptLlm({}).llm,
    toolSpecsFor: () => [],
    callTool: async () => ({ text: 'ok', isError: false }),
    preamble: 'OS RULES + software context',
    reasoningModel: 'sovereign-reasoning',
    execModel: 'sovereign-default',
    maxIterations: 2,
    ...over,
  };
}

test('nodeOrder walks the 6-agent team deterministically, communication last', () => {
  const order = nodeOrder(IR);
  assert.deepEqual(order, ['orchestrator', 'planner', 'builder', 'tester', 'deployer', 'communication']);
});

test('nodeOrder skips a disabled agent', () => {
  const order = nodeOrder(IR, new Set(['builder']));
  assert.ok(!order.includes('builder'), 'disabled builder is not in the order');
  assert.deepEqual(order, ['orchestrator', 'planner', 'tester', 'deployer', 'communication']);
});

test('per-node model routing: builder ACTs on sovereign-default, the rest on sovereign-reasoning', async () => {
  const { llm, seen } = scriptLlm({});
  await runAgenticGraph(IR, [{ role: 'user', content: 'build a todo app' }], baseDeps({ llm }));

  // Every node PLANs on the reasoning tier (no-tools calls all used reasoning).
  const planModels = new Set(seen.filter((s) => !s.hadTools).map((s) => s.model));
  assert.deepEqual([...planModels], ['sovereign-reasoning'], 'all PLAN calls use the reasoning tier');

  // The ACT tier per node = its pinned model: builder → default, others → reasoning.
  const actModels = seen.filter((s) => s.hadTools).map((s) => s.model);
  assert.ok(actModels.includes('sovereign-default'), 'builder ACTs on sovereign-default');
  assert.ok(actModels.includes('sovereign-reasoning'), 'other nodes ACT on sovereign-reasoning');
});

test('tool calls execute through the injected governed executor (runs as the running user)', async () => {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const callTool: ToolExecutor = async (name, args) => {
    executed.push({ name, args });
    return { text: `executed ${name}`, isError: false };
  };
  // Give the builder a create_software spec, and script its ACT to call it once.
  const spec: ToolSpec = {
    name: 'create_software',
    description: 'Create a governed app.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  };
  const { llm } = scriptLlm({
    // Builder: call the tool once, then finish (so the loop stops).
    'sovereign-default': [
      { content: '', toolCalls: [{ id: 'c1', name: 'create_software', args: { name: 'Todo' } }] },
      { content: 'created the app', toolCalls: [] },
    ],
  });
  await runAgenticGraph(
    IR,
    [{ role: 'user', content: 'build a todo app' }],
    baseDeps({ llm, toolSpecsFor: (n) => (n.id === 'builder' ? [spec] : []), callTool }),
  );

  assert.equal(executed.length, 1, 'exactly one governed tool call was made');
  assert.equal(executed[0].name, 'create_software');
  assert.deepEqual(executed[0].args, { name: 'Todo' });
});

test('communication node emits the user-facing progress as the single reply', async () => {
  const { llm } = scriptLlm({
    // Communication has no tools, so its ACT call returns a final narration.
    'sovereign-reasoning': { content: 'Built the Todo app; preview is up; deploy is pending Builder review.', toolCalls: [] },
  });
  const res = await runAgenticGraph(IR, [{ role: 'user', content: 'todo app' }], baseDeps({ llm }));
  assert.equal(res.path[res.path.length - 1], 'communication');
  assert.match(res.finalText, /pending Builder review/i);
});

// --- FIX 3 (correctness): the handoff carries a prior node's STRUCTURED output ---

test('handoff: a downstream node RECEIVES the prior node\'s material tool output, not just narration', async () => {
  // The orchestrator (first node) runs a tool that produces a scorecard; we then
  // capture the system prompt every LATER node is given, and assert the builder's
  // system context CONTAINS that scorecard data — the FIX 3 regression guard.
  const systemsSeen: { model: string; system: string }[] = [];
  const spec: ToolSpec = {
    name: 'query_metric',
    description: 'Fetch a metric.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
  const scorecard = '{"rows":[{"metric":"gross_margin","value":0.42,"grade":"B"}]}';
  let orchestratorToolCalled = false;
  const llm: LlmCall = async (req) => {
    if (!req.tools) return { content: 'plan', toolCalls: [] };
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    systemsSeen.push({ model: req.model, system });
    // The orchestrator (first node, no TEAM PROGRESS) calls query_metric exactly once,
    // then finishes; every later node finishes immediately.
    const isFirstNode = !system.includes('TEAM PROGRESS SO FAR');
    if (isFirstNode && !orchestratorToolCalled) {
      orchestratorToolCalled = true;
      return { content: '', toolCalls: [{ id: 'c1', name: 'query_metric', args: {} }] };
    }
    return { content: `done (${req.model})`, toolCalls: [] };
  };
  const callTool: ToolExecutor = async (name) =>
    name === 'query_metric' ? { text: scorecard, isError: false } : { text: 'ok', isError: false };

  await runAgenticGraph(
    IR,
    [{ role: 'user', content: 'evaluate margins' }],
    baseDeps({ llm, toolSpecsFor: (n) => (n.id === 'orchestrator' ? [spec] : []), callTool, maxIterations: 3 }),
  );

  // At least one LATER node's system prompt must contain the actual scorecard value
  // the orchestrator produced — proof the structured tool output was threaded forward.
  const downstream = systemsSeen.filter((s) => s.system.includes('TEAM PROGRESS SO FAR'));
  assert.ok(downstream.length > 0, 'a later node saw TEAM PROGRESS SO FAR');
  const carriesData = downstream.some((s) => s.system.includes('gross_margin') && s.system.includes('0.42'));
  assert.ok(carriesData, 'a downstream node received the prior node\'s scorecard DATA, not just its narration');
  // And the role preamble instructs the node to USE it and never re-ask the user.
  assert.ok(downstream[0].system.includes('NEVER ask the user'), 'downstream node is told never to re-ask the user for prior data');
});

// --- FIX 1 (progress): a node failure yields PARTIAL results, node marked failed ---

test('per-node failure: the run returns partial results with the failing node marked failed', async () => {
  // The builder (3rd node) throws; the run must return the nodes up to and including
  // it, with the builder status 'failed' and a reason — never abort the whole run.
  const llm: LlmCall = async (req) => {
    if (!req.tools) return { content: 'plan', toolCalls: [] };
    return { content: `done (${req.model})`, toolCalls: [] };
  };
  const callTool: ToolExecutor = async () => {
    throw new Error('OPA denied: builder tool unavailable');
  };
  const spec: ToolSpec = {
    name: 'create_software',
    description: 'Create.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
  // Make ONLY the builder call a tool (which throws); others finish cleanly.
  const scriptLlm2: LlmCall = async (req) => {
    if (!req.tools) return { content: 'plan', toolCalls: [] };
    if (req.model === 'sovereign-default') return { content: '', toolCalls: [{ id: 'c1', name: 'create_software', args: {} }] };
    return { content: `done (${req.model})`, toolCalls: [] };
  };
  void llm;
  const res = await runAgenticGraph(
    IR,
    [{ role: 'user', content: 'build it' }],
    baseDeps({ llm: scriptLlm2, toolSpecsFor: (n) => (n.id === 'builder' ? [spec] : []), callTool, maxIterations: 3 }),
  );

  const builder = res.runs.find((r) => r.node === 'builder');
  assert.ok(builder, 'the builder node is present in the partial results');
  assert.equal(builder!.status, 'failed', 'the builder is marked failed');
  assert.match(builder!.error ?? '', /OPA denied/, 'the failure reason is carried');
  // Partial: the run stopped AT the failed node — deployer/communication did not run.
  assert.ok(!res.runs.some((r) => r.node === 'communication'), 'the run stopped at the failed node (no downstream nodes)');
  // Earlier nodes still ran and are marked ok.
  assert.equal(res.runs.find((r) => r.node === 'orchestrator')?.status, 'ok', 'earlier nodes ran ok');
});

test('DEPLOY GATE: the seeded team never grants decide_deploy, and a creator is never offered it', () => {
  const sys = parseSystem(SOFTWARE_TEAM_YAML);
  // (a) The system grants exclude the go-live approval tool by construction.
  assert.ok(!sys.grants.tools.includes('decide_deploy'), 'decide_deploy is NOT granted to the team');
  // (b) The real per-user role floor: a creator's software tools exclude the
  //     elevated set (decide_deploy/promote/delete) but include request_deploy.
  const creatorTools = new Set(listToolsForRole('creator', toolsForTab('software')).map((t) => t.name));
  assert.ok(!creatorTools.has('decide_deploy'), 'a creator is never offered decide_deploy');
  assert.ok(creatorTools.has('request_deploy'), 'a creator CAN request a deploy');
  assert.ok(creatorTools.has('create_software') && creatorTools.has('commit'), 'a creator can build');
  // (c) A builder, by contrast, CAN decide — proving the floor is role-scoped.
  const builderTools = new Set(listToolsForRole('builder', toolsForTab('software')).map((t) => t.name));
  assert.ok(builderTools.has('decide_deploy'), 'a builder CAN approve a deploy');
});
