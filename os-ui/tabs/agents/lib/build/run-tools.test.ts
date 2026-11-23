/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A system key allows exactly the tools a run of the system can send to LiteLLM
 * USER STORY: As the owner I want my agent system's run never refused by the gateway with
 *             `tool_access_denied` for a tool the OS itself offered (dev, 23 Nov 2026: the Invoice
 *             agent, refused for author_workflow, index_workflow, list_workflows, get_workflow and
 *             delegate_to_worker), and its key to allow nothing a run never offers.
 * ARCHITECTURE:
 *   - PROPERTY over representative systems: the REAL run (`runOsTeam`, the yaml `prepareRun` hands
 *     it — `withOutputTools` applied) with a scripted model that RECORDS the `tools` of every request,
 *     under BOTH settings of the OS-wide lead switch, compared with `keyWanted` — the function the
 *     Build's litellm step stamps the key with and the reconcile compares against.
 *       · every tool any request carried ⊆ the key's allowed tools;
 *       · NEGATIVE TWIN: the key holds nothing the runs never offered (the module engine's own
 *         `set_state` is the one name the v1 engine cannot show, and only for a channel writer).
 *   - The scripted model visits every agent (a supervisor routes to each member; a channel writer
 *     sets its channel), so "never offered" really means never.
 *   - NO LEAD TOOLS (owner decision 23 Nov 2026): under either setting of the lead switch, an agent run
 *     offers neither `delegate_to_worker` nor `escalate_to_strong`, and the key allows neither.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { withOutputTools } from '@tabs/agents/lib/output-tools';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { keyWanted } from '@tabs/agents/lib/build/live';
import { runOfferedToolNames } from '@tabs/agents/lib/build/run-tools';
import { __setStandardFirstForTests, roleModel } from '@core/models/roles';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';
import { MODULE_SET_STATE_TOOL, MODULE_ROUTE_TOOL, moduleTeam, moduleEngineToolNames, generateAgentModule } from '@tabs/agents/lib/module/generate';

after(() => __setStandardFirstForTests(false));

const ADMIN: CurrentUser = { id: 'u-admin', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'admin' };

/** The Invoice agent's shape: a workflow grant at write, notes, and a declared knowledge output. */
const WORKFLOWS_YAML = `
system: { name: Invoice agent, domain: sales, visibility: Personal }
entrypoint: clerk
grants:
  workflows:
    - { id: wf_invoice_process, capability: Write-bounded }
  knowledge:
    - id: ''
      capability: Write-bounded
      folder: { path: /invoices, scope: personal }
  tools: [search_knowledge, list_workflows, get_workflow, author_workflow, index_workflow]
outputs:
  - { kind: knowledge, name: Invoice summary, folder: { path: /invoices, scope: personal } }
agents:
  - { id: clerk, role: Reads invoices and documents the process, agent_md: "# Clerk", memory_md: "" }
`;

const MINIMAL_YAML = `
system: { name: Minimal, domain: sales, visibility: Personal }
entrypoint: solo
grants:
  tools: []
agents:
  - { id: solo, role: answers, agent_md: "# Solo", memory_md: "" }
`;

/** Two agents, each narrowed: a reader hands off to a writer (output write tool to the producer only). */
const OUTPUTS_YAML = `
system: { name: Reports, domain: sales, visibility: Personal }
entrypoint: reader
grants:
  knowledge:
    - id: ''
      capability: Write-bounded
      folder: { path: /results, scope: personal }
  tools: [list_files, search_knowledge]
outputs:
  - { kind: knowledge, name: Result, agent: writer, folder: { path: /results, scope: personal } }
agents:
  - { id: reader, role: reads, agent_md: "# Reader", memory_md: "", tools: [list_files] }
  - { id: writer, role: writes, agent_md: "# Writer", memory_md: "", tools: [search_knowledge] }
edges:
  - { from: reader, to: writer, type: handoff }
`;

/** A supervisor with two members (the engine's `route` tool) and data reads with discovery companions. */
const SUPERVISOR_YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: lead
grants:
  tools: [search_knowledge, query_data]
agents:
  - { id: lead, role: routes, agent_md: "# Lead", memory_md: "", tools: [], members: [researcher, analyst] }
  - { id: researcher, role: reads knowledge, agent_md: "# Researcher", memory_md: "", tools: [search_knowledge] }
  - { id: analyst, role: queries data, agent_md: "# Analyst", memory_md: "", tools: [query_data] }
edges:
  - { from: lead, to: researcher, type: supervise }
  - { from: lead, to: analyst, type: supervise }
`;

/** A guarded handoff whose channel the planner sets (the engine's `os_set_state` tool). */
const CHANNEL_YAML = `
system: { name: Planner, domain: sales, visibility: Personal }
entrypoint: planner
state:
  channels: { messages: add_messages, plan_ready: boolean }
grants:
  tools: [search_knowledge, query_data]
agents:
  - { id: planner, role: plans, agent_md: "# Planner", memory_md: "", tools: [search_knowledge] }
  - { id: builder, role: builds, agent_md: "# Builder", memory_md: "", tools: [query_data] }
edges:
  - { from: planner, to: builder, type: handoff, when: plan_ready }
`;

const SYSTEMS: Record<string, string> = {
  'workflows grant (the Invoice agent)': WORKFLOWS_YAML,
  minimal: MINIMAL_YAML,
  'declared output, narrowed agents': OUTPUTS_YAML,
  'supervisor with members': SUPERVISOR_YAML,
  'guarded channel writer': CHANNEL_YAML,
};

const toolDeps: OsToolDeps = {
  enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
  handleRpc: (async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })) as OsToolDeps['handleRpc'],
  trace: (async () => ({}) as never) as OsToolDeps['trace'],
};

/**
 * A model that records every request's tools and walks the whole team: a supervisor routes to each
 * member once, then END; an agent offered `os_set_state` sets each channel it may once; otherwise "done".
 */
function recordingModel(offered: Set<string>): LlmCall {
  const routed = new Set<string>();
  const set = new Set<string>();
  let n = 0;
  return async (req: LlmRequest) => {
    const names = (req.tools ?? []).map((t) => t.function.name);
    for (const t of names) offered.add(t);
    const id = () => `c${++n}`;
    const route = req.tools?.find((t) => t.function.name === 'route');
    if (route) {
      const members = ((route.function.parameters as unknown as { properties: { next: { enum: string[] } } }).properties.next.enum).filter((m) => m !== 'END');
      const next = members.find((m) => !routed.has(m)) ?? 'END';
      routed.add(next);
      return { content: '', toolCalls: [{ id: id(), name: 'route', args: { next, brief: 'go' } }] };
    }
    const setter = req.tools?.find((t) => t.function.name === 'os_set_state');
    if (setter) {
      const channels = (setter.function.parameters as unknown as { properties: { channel: { enum: string[] } } }).properties.channel.enum.filter((c) => !set.has(c));
      if (channels.length > 0) {
        set.add(channels[0]);
        return { content: '', toolCalls: [{ id: id(), name: 'os_set_state', args: { channel: channels[0], value: true } }] };
      }
    }
    return { content: req.tools ? 'done' : '1. do it', toolCalls: [] };
  };
}

/** The yaml a run executes (`prepareRun`: the saved definition with its outputs' write tools handed out). */
const runYaml = (yaml: string) => serializeSystem(withOutputTools(parseSystem(yaml)));

/** Every tool name the real run sent to the model, under one setting of the lead switch. */
async function offeredByRun(yaml: string, workerLeads: boolean, tag: string): Promise<Set<string>> {
  __setStandardFirstForTests(workerLeads);
  const offered = new Set<string>();
  const res = await runOsTeam({ runId: `run-tools-${tag}-${workerLeads ? 'worker' : 'strong'}`, user: ADMIN, yaml: runYaml(yaml), systemId: `sys_${tag}`, messages: [{ role: 'user', content: 'go' }], llm: recordingModel(offered), toolDeps, maxIterations: 4 });
  assert.ok(!res.failed, `${tag}: the run failed: ${res.failure?.reason}`);
  return offered;
}

/** The key's allowed tools, exactly as the Build stamps them. */
async function keyTools(yaml: string, systemId: string): Promise<string[]> {
  const system = parseSystem(yaml);
  const want = await keyWanted({ caps: undefined })({ system, ir: compile(system), systemId });
  return want.allowedTools;
}

for (const [name, yaml] of Object.entries(SYSTEMS)) {
  const tag = name.replace(/[^a-z]+/gi, '_');
  test(`PROPERTY (${name}): every tool a run sends to the gateway is allowed on the system key — both lead modes`, async () => {
    const allowed = new Set(await keyTools(yaml, `sys_${tag}`));
    for (const workerLeads of [false, true]) {
      const offered = await offeredByRun(yaml, workerLeads, tag);
      const refused = [...offered].filter((t) => !allowed.has(t));
      assert.deepEqual(refused, [], `${workerLeads ? 'worker' : 'strong'} leads: the gateway would refuse ${refused.join(', ')} (key: ${[...allowed].join(', ')})`);
    }
  });

  test(`NEGATIVE TWIN (${name}): the key allows nothing a run of the system never offers`, async () => {
    const offered = new Set<string>();
    for (const workerLeads of [false, true]) for (const t of await offeredByRun(yaml, workerLeads, `${tag}_twin`)) offered.add(t);
    // The module engine (`AGENT_GRAPH_MODULE`) names its channel tool `set_state`; a v1 run cannot show it.
    const sys = withOutputTools(parseSystem(yaml));
    for (const t of moduleEngineToolNames(moduleTeam(sys, compile(sys)))) offered.add(t);
    const unused = (await keyTools(yaml, `sys_${tag}`)).filter((t) => !offered.has(t));
    assert.deepEqual(unused, [], `the key allows ${unused.join(', ')}, which no run of this system offers`);
  });
}

test('REGRESSION (dev, 23 Nov 2026): the Invoice agent key allows the five tools the gateway refused', async () => {
  const allowed = await keyTools(WORKFLOWS_YAML, 'sys_invoice');
  for (const t of ['author_workflow', 'index_workflow', 'list_workflows', 'get_workflow']) {
    assert.ok(allowed.includes(t), `${t} is not allowed: ${allowed.join(', ')}`);
  }
  // The fifth refused name was the lead tool: agent runs no longer offer it, so the key no longer allows it.
  assert.ok(!allowed.includes('delegate_to_worker'), allowed.join(', '));
});

test('REGRESSION, old spelling: a system saved with author_knowledge/index_knowledge and a wf_ grant under knowledge gets the workflow names on its key', async () => {
  const legacy = `
system: { name: Invoice agent, domain: sales, visibility: Personal }
entrypoint: clerk
grants:
  knowledge:
    - { id: wf_invoice_process, capability: Write-bounded }
  tools: [list_knowledge, get_knowledge, author_knowledge, index_knowledge]
agents:
  - { id: clerk, role: r, agent_md: "# Clerk", memory_md: "" }
`;
  const allowed = await keyTools(legacy, 'sys_invoice_legacy');
  for (const t of ['author_workflow', 'index_workflow', 'list_workflows', 'get_workflow']) assert.ok(allowed.includes(t), `${t}: ${allowed.join(', ')}`);
  for (const t of ['author_knowledge', 'index_knowledge']) assert.ok(!allowed.includes(t), `the old name ${t} is never sent to the model`);
});

test('a READ-only workflow grant puts no workflow WRITE tool on the key (and the run offers none)', async () => {
  const read = `
system: { name: Reader, domain: sales, visibility: Personal }
entrypoint: r
grants:
  workflows:
    - { id: wf_invoice_process, capability: Read }
  tools: [list_workflows, get_workflow]
agents:
  - { id: r, role: r, agent_md: "# R", memory_md: "" }
`;
  const allowed = await keyTools(read, 'sys_wf_read');
  for (const t of ['author_workflow', 'index_workflow', 'publish_workflow', 'retire_workflow']) assert.ok(!allowed.includes(t), t);
  const offered = await offeredByRun(read, false, 'wf_read');
  for (const t of ['author_workflow', 'index_workflow']) assert.ok(!offered.has(t), `the run offered ${t}`);
});

test('the key carries no OPA-only names: raw legacy grants and connection_<id> are never sent to the model', async () => {
  const yaml = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: w
grants:
  connections:
    - { id: crm, capability: Read }
  tools: [retrieve]
agents:
  - { id: w, role: w, agent_md: "# W", memory_md: "" }
`;
  const allowed = await keyTools(yaml, 'sys_opa_only');
  assert.ok(allowed.includes('search_knowledge'), 'the resolved name the run sends');
  assert.ok(!allowed.includes('retrieve'), 'the raw legacy name');
  assert.ok(!allowed.includes('connection_crm'), 'the OPA connection tool');
  assert.ok(!allowed.includes('enable_tools'), 'the assistant chat tool');
});

for (const [name, yaml] of Object.entries(SYSTEMS)) {
  const tag = `nolead_${name.replace(/[^a-z]+/gi, '_')}`;
  test(`NO HAND-OFF (${name}): whichever way the lead switch is set, a run offers no lead tool, runs every call on the strong model, and the key allows no lead tool`, async () => {
    const lead = ['delegate_to_worker', 'escalate_to_strong'];
    for (const workerLeads of [false, true]) {
      __setStandardFirstForTests(workerLeads);
      const offered = new Set<string>();
      const models = new Set<string>();
      const base = recordingModel(offered);
      const res = await runOsTeam({ runId: `run-tools-${tag}-${workerLeads}`, user: ADMIN, yaml: runYaml(yaml), systemId: `sys_${tag}`, messages: [{ role: 'user', content: 'go' }], llm: async (req) => { models.add(req.model); return base(req); }, toolDeps, maxIterations: 4 });
      assert.ok(!res.failed, res.failure?.reason);
      for (const t of lead) assert.ok(!offered.has(t), `${workerLeads ? 'worker' : 'strong'} leads: the run offered ${t}`);
      assert.deepEqual([...models], [roleModel('reasoning')], `${workerLeads ? 'worker' : 'strong'} leads: one model per agent`);
      assert.ok(res.runs.every((r) => r.model === roleModel('reasoning')), res.runs.map((r) => r.model).join(','));
    }
    const allowed = await keyTools(yaml, `sys_${tag}`);
    for (const t of lead) assert.ok(!allowed.includes(t), `the key allows ${t}`);
  });
}

test('runOfferedToolNames is the key list (keyWanted stamps it unchanged)', async () => {
  const system = parseSystem(SUPERVISOR_YAML);
  assert.deepEqual(await keyTools(SUPERVISOR_YAML, 'sys_same'), await runOfferedToolNames(system));
});

test('the generated module graph names its own tools exactly as moduleEngineToolNames says', () => {
  const mod = generateAgentModule({ id: 'sys_mod', slug: 'mod', sys: parseSystem(CHANNEL_YAML), ...hostModuleInputs() });
  const graph = [...mod.files.entries()].find(([p]) => p.endsWith('graph.mjs'))![1];
  assert.ok(graph.includes(`name: '${MODULE_SET_STATE_TOOL}'`), 'set_state');
  assert.ok(graph.includes(`name: '${MODULE_ROUTE_TOOL}'`), 'route');
});

// ------------------------------------------------------------------ the per-agent model (strong · standard · auto)

const PER_NODE_YAML = `
system: { name: Pair, domain: sales, visibility: Personal }
entrypoint: judge
grants:
  tools: [search_knowledge]
agents:
  - { id: judge, role: decides, agent_md: "# Judge", memory_md: "", model: strong }
  - { id: reader, role: reads, agent_md: "# Reader", memory_md: "", model: auto, model_resolved: standard, model_reason: "reads only" }
edges:
  - { from: judge, to: reader, type: handoff }
`;

test('PER-NODE MODEL: each agent plans and acts on exactly its own model (strong, and Auto resolved to standard); the run report shows it', async () => {
  const calls: { model: string; agent: string }[] = [];
  const offered = new Set<string>();
  const base = recordingModel(offered);
  const res = await runOsTeam({
    runId: 'run-tools-per-node', user: ADMIN, yaml: runYaml(PER_NODE_YAML), systemId: 'sys_per_node', messages: [{ role: 'user', content: 'go' }], toolDeps, maxIterations: 4,
    llm: async (req) => { const sys = String(req.messages[0]?.content ?? ''); calls.push({ model: req.model, agent: sys.includes('# Reader') ? 'reader' : 'judge' }); return base(req); },
  });
  assert.ok(!res.failed, res.failure?.reason);
  assert.ok(calls.some((c) => c.agent === 'reader') && calls.some((c) => c.agent === 'judge'));
  for (const c of calls) assert.equal(c.model, c.agent === 'reader' ? 'sovereign-worker' : 'sovereign-strong', JSON.stringify(c));
  assert.deepEqual(res.runs.map((r) => [r.node, r.model]), [['judge', 'sovereign-strong'], ['reader', 'sovereign-worker']]);
  assert.match(res.runs[1].tierReason ?? '', /Auto chose Standard: reads only/);
  const key = await keyWanted({ caps: undefined })({ system: parseSystem(PER_NODE_YAML), ir: compile(parseSystem(PER_NODE_YAML)), systemId: 'sys_per_node' });
  assert.deepEqual([...key.models].sort(), ['sovereign-strong', 'sovereign-worker'], 'the key allows exactly the two roles used');
});
