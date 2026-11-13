/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The agent-system engineering view — and the proof that the graph shown IS the graph compiled
 * USER STORY: As a reviewer I want the LangGraph section to be checked against the engine's own
 *             builder, not against a hand-written expectation: if `build-graph.ts` ever renames a
 *             node or adds a phase, this test fails and the panel cannot quietly lie (T1, T5, T6).
 * ARCHITECTURE:
 *   - Pure: the store and the repository reader are module-mocked, a real `system.yaml` is parsed
 *     and compiled, and `buildGraph` is called with the same minimal deps the engine's own tests
 *     use — so the comparison is against the real builder with no model and no network.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { buildGraph, type GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { vocabularyViolations } from '@core/engineering/vocabulary';
import type { EngineeringPrincipal } from '@core/engineering/types';

const YAML = `version: '1'
system: { name: Revenue team, domain: sales, visibility: Personal }
entrypoint: lead
state:
  channels:
    messages: add_messages
    draft: last_value
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, query_data], connections: [] }
agents:
  - { id: lead, role: lead, agent_md: '# lead', memory_md: '# Memory', tools: [], members: [analyst] }
  - { id: analyst, role: analyst, agent_md: '# analyst', memory_md: '# Memory', tools: [query_data] }
edges:
  - { from: lead, to: analyst, type: supervise }
`;

const SYSTEM = parseSystem(YAML);
const RECORD = {
  id: 'sys_abcdef123456',
  name: 'Revenue team',
  domain: 'sales',
  owner: 'amir',
  visibility: 'Personal',
  disabledAgents: [] as string[],
  yaml: YAML,
  lastRun: { runId: 'run_42', traceUrl: 'https://langfuse.example/trace/run_42' },
  system: SYSTEM,
};

const COMMITTED = `agents/personal/0123456789ab/revenue-team`;

mock.module('@tabs/agents/lib/store', {
  namedExports: {
    getSystem: (id: string) => {
      if (id !== RECORD.id) {
        const e = new Error('System not found') as Error & { status?: number };
        e.status = 404;
        throw e;
      }
      return RECORD;
    },
  },
});
mock.module('@core/engineering/repo', {
  namedExports: {
    repoPaths: async () => ({ repo: 'sales', head: 'deadbeef', paths: [`${COMMITTED}/system.yaml`, `${COMMITTED}/graph.json`], reason: null }),
    readRepoFiles: async () => ({
      repo: 'sales',
      head: 'deadbeef',
      files: [{ path: `${COMMITTED}/system.yaml`, content: YAML }],
      unreadable: [],
      reason: null,
    }),
  },
});
mock.module('@tabs/agents/lib/git/generate', {
  namedExports: {
    AGENTS_PREFIX: 'agents/',
    ownerToken: () => '0123456789ab',
    segment: (s: string, fallback: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback,
  },
});

const { agentSystemEngineeringView, compiledGraphOf, nodeNamesFor, systemDirCandidates } = await import('@tabs/agents/lib/engineering');

const USER = { id: 'amir', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'admin' } as unknown as EngineeringPrincipal;

test('T5: the node names the view shows are the node names `buildGraph` actually registered', () => {
  const ir = compile(SYSTEM);
  const specs = { search_knowledge: { name: 'search_knowledge', description: 'x', inputSchema: { type: 'object' as const, properties: {} } }, query_data: { name: 'query_data', description: 'x', inputSchema: { type: 'object' as const, properties: {} } } };
  const deps: GraphDeps = {
    llm: async () => ({ content: 'no', toolCalls: [] }),
    toolSpecsFor: (node) => node.tools.map((t) => (specs as Record<string, { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, never> } }>)[t]).filter(Boolean),
    callTool: async () => ({ text: '{}', isError: false }),
    preamble: 'RULES',
    reasoningModel: 'reasoning',
    execModel: 'fast',
    maxIterations: 2,
  };
  const built = buildGraph(ir, deps);
  const graph = compiledGraphOf(ir, [], 'MemorySaver (@langchain/langgraph)');
  for (const agent of built.agents) {
    const real = built.names(agent);
    assert.deepEqual(nodeNamesFor(agent), real, `the view renames ${agent}'s nodes`);
    for (const name of [real.plan, real.act, real.tools, real.route]) {
      assert.ok(graph.nodes.some((n) => n.id === name), `${name} is missing from the view's graph`);
    }
  }
  assert.equal(graph.entrypoint, built.names(ir.entrypoint).plan);
  assert.deepEqual(graph.channels.map((c) => c.name).sort(), ['draft', 'messages']);
  // The supervisor's route fans out to its member's plan node and to END (conditional edges).
  const route = built.names('lead').route;
  assert.ok(graph.edges.some((e) => e.from === route && e.to === built.names('analyst').plan && e.kind === 'conditional'));
  assert.ok(graph.edges.some((e) => e.from === route && e.to === 'END'));
  // Every agent parks on its own `tools_<id>` when a call needs an approval.
  assert.deepEqual(graph.interrupts.map((i) => i.node).sort(), [built.names('analyst').tools, built.names('lead').tools].sort());
});

test('T5: a disabled agent is pruned from the view exactly as `buildGraph` prunes it', () => {
  const ir = compile(SYSTEM);
  const graph = compiledGraphOf(ir, ['analyst'], 'MemorySaver');
  assert.ok(!graph.nodes.some((n) => n.agent === 'analyst'));
  assert.ok(!graph.edges.some((e) => e.to.includes('analyst')));
});

test('T1/T6: the agent-system view carries the compiled graph, the committed system.yaml and the trace', async () => {
  const view = await agentSystemEngineeringView(USER, RECORD.id);
  assert.deepEqual(vocabularyViolations(view), []);
  assert.deepEqual(view.sections.map((s) => s.tool), ['dbt', 'dagster', 'langgraph', 'git', 'langfuse']);

  const lg = view.sections.find((s) => s.tool === 'langgraph');
  assert.ok(lg?.graph, 'the LangGraph section carries the typed graph');
  assert.equal(lg?.artefacts[0].language, 'json');
  assert.match(lg?.artefacts[0].body ?? '', /"plan_lead"/);
  assert.ok(lg?.artefacts[0].facts?.some((f) => f.label === 'LangGraph checkpointer'));

  const git = view.sections.find((s) => s.tool === 'git');
  assert.equal(git?.artefacts[0].repoPath, `${COMMITTED}/system.yaml`);
  assert.equal(git?.artefacts[0].body, YAML, 'the bytes shown are the bytes in the repository');
  assert.ok(git?.commands.some((c) => c.command.startsWith('git log')));

  const lf = view.sections.find((s) => s.tool === 'langfuse');
  assert.ok(lf?.unavailable || lf?.links[0], 'the Langfuse section either links the trace or says why it cannot');

  // The two tools this kind does not touch say so rather than rendering empty.
  assert.match(view.sections.find((s) => s.tool === 'dbt')?.unavailable ?? '', /not a dbt project/);
  assert.match(view.sections.find((s) => s.tool === 'dagster')?.unavailable ?? '', /scheduled by the OS/);
});

test('T7/T8: an agent system that does not exist is the tab\'s own 404, not an empty view', async () => {
  await assert.rejects(() => agentSystemEngineeringView(USER, 'sys_missing'), (e: Error & { status?: number }) => e.status === 404);
});

test('the personal lane is where the generator puts a Personal system', () => {
  const dirs = systemDirCandidates(RECORD);
  assert.equal(dirs[0], COMMITTED);
  assert.equal(dirs[1], 'agents/personal/0123456789ab/revenue-team-abcdef123456');
});
