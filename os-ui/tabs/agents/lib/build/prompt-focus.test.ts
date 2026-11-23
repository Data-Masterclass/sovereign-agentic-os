/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Agent-run prompts carry each thing once, per agent, without contradictions
 * USER STORY: As the owner I want each agent's model call to carry its tools once (natively, compact, naming no tool
 *             it cannot call), its own results and grants, no software-team wording, and the worker role run with the
 *             sampling OpenAI recommends — while the chat and the software builder stay exactly as they are.
 * ARCHITECTURE: the REAL run (`runOsTeam`) with a model that records every request; the chat's `actSystem` default is
 *             pinned byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { actSystem, type LlmCall, type LlmRequest, type ToolSpec } from '@core/runtime/agentic';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { compactToolSpecs, mentionsTool } from '@tabs/agents/lib/build/tool-brief';
import { configuredRoleTemperature, configuredWorkerReasoningEfforts } from '@core/runtime/reasoning-budget';

const USER: CurrentUser = { id: 'u-pf', name: 'Pat', domains: ['finance'], allDomains: ['finance'], activeDomain: 'finance', role: 'creator' };
const toolDeps: OsToolDeps = {
  enqueue: (() => ({})) as never,
  handleRpc: (async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })) as never,
  trace: (async () => ({})) as never,
};

const yaml = (narrow: boolean) => serializeSystem(parseSystem({
  version: '1',
  system: { name: 'Invoice check', domain: 'finance', visibility: 'Personal' },
  entrypoint: 'reader',
  grants: {
    tools: ['list_files', 'get_file', 'get_knowledge', 'get_dataset', 'query_data', 'upload_file', 'list_datasets', 'create_dataset', 'ingest_dataset'],
    data: [{ folder: { path: '/verification', scope: 'personal' }, capability: 'Write-bounded' }],
    files: [{ folder: { path: '/invoices', scope: 'domain' }, capability: 'Read' }, { folder: { path: '/reports', scope: 'personal' }, capability: 'Write-bounded' }],
  },
  outputs: [
    { kind: 'files', name: 'Verification report', folder: { path: '/reports', scope: 'personal' } },
    { kind: 'data', name: 'Verified invoices', folder: { path: '/verification', scope: 'personal' } },
  ],
  agents: [
    { id: 'reader', role: 'Reads invoices', agent_md: '# reader\n\nRead the invoices.', memory_md: '', ...(narrow ? { tools: ['list_files', 'get_file'] } : {}) },
    { id: 'verifier', role: 'Verifies', agent_md: '# verifier\n\nVerify and report.', memory_md: '', ...(narrow ? { tools: ['query_data', 'get_dataset'] } : {}), model: 'standard' },
  ],
  edges: [{ from: 'reader', to: 'verifier', type: 'handoff' }],
} as never));

type Req = { node: string; kind: 'plan' | 'act'; req: LlmRequest; system: string };
async function record(narrow: boolean): Promise<Req[]> {
  const seen: Req[] = [];
  const llm: LlmCall = async (req) => {
    const system = String(req.messages[0]?.content ?? '');
    seen.push({ node: system.includes('# verifier') ? 'verifier' : 'reader', kind: req.tools ? 'act' : 'plan', req, system });
    return { content: req.tools ? 'done' : '1. do it', toolCalls: [] };
  };
  const res = await runOsTeam({ runId: `pf-${narrow}-${Math.random()}`, user: USER, yaml: yaml(narrow), systemId: 'sys_pf', messages: [{ role: 'user', content: 'go' }], llm, toolDeps, maxIterations: 3 });
  assert.ok(!res.failed, res.failure?.reason);
  return seen;
}

const KNOWN = ALL_MCP_TOOLS.map((t) => t.name);

test('ONCE: an ACT call carries the tools only as native definitions (no prompt list, no preamble brief)', async () => {
  for (const r of (await record(false)).filter((x) => x.kind === 'act')) {
    assert.doesNotMatch(r.system, /Available tools:/);
    assert.doesNotMatch(r.system, /YOUR GRANTED TOOLS/);
    assert.ok((r.req.tools ?? []).length > 0);
  }
});

test('the PLAN call (no native tools) lists the node\'s OWN tools in one line each — and only those', async () => {
  const seen = await record(true);
  const plan = seen.find((r) => r.node === 'reader' && r.kind === 'plan')!;
  assert.match(plan.system, /Your tools \(their full definitions come with the next step\):/);
  assert.match(plan.system, /\n- get_file — /);
  assert.doesNotMatch(plan.system, /\n- query_data — /, 'the verifier\'s tool is not the reader\'s');
});

test('NO SOFTWARE-TEAM WORDING in an agent run; the chat/builder default actSystem is unchanged byte for byte', async () => {
  for (const r of await record(false)) assert.doesNotMatch(r.system, /preview URL|deploy-review/);
  const tools: ToolSpec[] = [{ name: 'whoami', description: 'Who am I.', inputSchema: { type: 'object', properties: {} } }];
  assert.equal(actSystem('SYS', 'PLAN', tools, false), [
    'SYS', '',
    'You now EXECUTE this plan by calling the available tools. Do real work — do not',
    'just describe it. Call one tool at a time; use each result to decide the next',
    'step. When the goal is met, stop and give a concise final summary of what you',
    'did (files committed, preview URL, deploy-review status).',
    '', '', 'Your plan:', 'PLAN', '', 'Available tools:', '- whoami: Who am I.', '',
  ].join('\n'));
});

test('PER NODE: each agent is told only the results it produces; a document + a dataset in one answer use sections', async () => {
  const seen = await record(false);
  const verifierPlan = seen.find((r) => r.node === 'verifier' && r.kind === 'plan')!;
  assert.match(verifierPlan.system, /=== OUTPUT: Verification report ===/);
  assert.match(verifierPlan.system, /you do not save it yourself/);
  assert.doesNotMatch(verifierPlan.system, /do NOT call a tool to save it/);
});

test('COMPACT: no tool description (or argument doc) sent to a node mentions a tool that node is not offered', async () => {
  for (const narrow of [false, true]) {
    for (const r of (await record(narrow)).filter((x) => x.kind === 'act')) {
      const offered = (r.req.tools ?? []).map((t) => t.function.name);
      const foreign = KNOWN.filter((n) => !offered.includes(n));
      for (const t of r.req.tools ?? []) {
        const text = `${t.function.description} ${JSON.stringify(t.function.parameters)}`;
        assert.equal(mentionsTool(text, foreign), null, `${r.node}/${t.function.name} mentions a tool it is not offered`);
        assert.doesNotMatch(t.function.description, /Purpose:|Before:|After:|Governance:/, `${t.function.name}: manual parts are gone`);
      }
    }
  }
});

test('COMPACT keeps names and argument shapes; only words change (twin: MCP descriptions are untouched)', () => {
  const real = ALL_MCP_TOOLS.find((t) => t.name === 'get_file')!;
  const spec: ToolSpec = { name: real.name, description: real.description, inputSchema: real.inputSchema as ToolSpec['inputSchema'] };
  const [c] = compactToolSpecs([spec], KNOWN);
  assert.equal(c.name, 'get_file');
  assert.deepEqual(Object.keys((c.inputSchema as { properties: object }).properties), Object.keys((spec.inputSchema as { properties: object }).properties));
  assert.ok(c.description.length < real.description.length / 3);
  assert.match(real.description, /Purpose:/, 'the MCP surface keeps its full description');
});

test('NARROWED agents get far fewer tool definitions per call (the builder now writes per-agent tools)', async () => {
  const wide = (await record(false)).filter((r) => r.kind === 'act' && r.node === 'reader')[0];
  const narrow = (await record(true)).filter((r) => r.kind === 'act' && r.node === 'reader')[0];
  assert.ok(JSON.stringify(narrow.req.tools).length < JSON.stringify(wide.req.tools).length / 2);
});

test('PER ROLE: the worker runs at the configured temperature and effort, strong keeps its own (chart env)', () => {
  assert.equal(configuredRoleTemperature('worker', {}), 0.2, 'unset = the old value');
  assert.equal(configuredRoleTemperature('worker', { MODEL_TEMPERATURE_WORKER: '1' }), 1);
  assert.equal(configuredRoleTemperature('strong', { MODEL_TEMPERATURE_WORKER: '1' }), 0.2);
  assert.equal(configuredRoleTemperature('worker', { MODEL_TEMPERATURE_WORKER: 'hot' }), 0.2);
  assert.deepEqual(configuredWorkerReasoningEfforts({ MODEL_REASONING_EFFORT_WORKER_ACT: 'low', MODEL_REASONING_EFFORT_WORKER_PLAN: 'medium' }), { act: 'low', plan: 'medium' });
  assert.deepEqual(configuredWorkerReasoningEfforts({ MODEL_REASONING_EFFORT_FINAL: 'high' }), { final: 'high' }, 'falls back to the role-free value');
});

test('PER ROLE in a run: the standard agent\'s calls carry the worker settings, the strong agent\'s do not', async () => {
  const prev = { t: process.env.MODEL_TEMPERATURE_WORKER, a: process.env.MODEL_REASONING_EFFORT_WORKER_ACT, p: process.env.MODEL_REASONING_EFFORT_WORKER_PLAN };
  process.env.MODEL_TEMPERATURE_WORKER = '1';
  process.env.MODEL_REASONING_EFFORT_WORKER_ACT = 'low';
  process.env.MODEL_REASONING_EFFORT_WORKER_PLAN = 'medium';
  try {
    const seen = await record(true);
    for (const r of seen.filter((x) => x.node === 'verifier')) {
      assert.equal(r.req.model, 'sovereign-worker');
      assert.equal(r.req.temperature, 1);
      assert.equal(r.req.reasoningEffort, r.kind === 'plan' ? 'medium' : 'low');
    }
    for (const r of seen.filter((x) => x.node === 'reader')) {
      assert.equal(r.req.model, 'sovereign-strong');
      assert.equal(r.req.temperature, 0.2);
      assert.equal(r.req.reasoningEffort, undefined);
    }
  } finally {
    for (const [k, v] of [['MODEL_TEMPERATURE_WORKER', prev.t], ['MODEL_REASONING_EFFORT_WORKER_ACT', prev.a], ['MODEL_REASONING_EFFORT_WORKER_PLAN', prev.p]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
