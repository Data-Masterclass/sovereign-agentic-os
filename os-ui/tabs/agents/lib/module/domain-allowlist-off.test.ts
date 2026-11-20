/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53d — with AGENT_GRAPH_MODULE OFF (the rollback) a parked module run still
 *             resumes on the module, and a resume that cannot be placed fails visibly
 * USER STORY: As the operator I want to switch the module path on for `test` only, see every other
 *             domain stay on today's engine, and change the allowlist without moving a parked run.
 * ARCHITECTURE:
 *   - `runOsTeam` — the ONE entry os-ui and the worker both call — with the environment set before
 *     import (`AGENT_GRAPH_MODULE=false`, `AGENT_GRAPH_MODULE_DOMAINS=test`). The v1 engine runs for
 *     real on a scripted model; the module path's entry (`runOsTeamOnModule`) and its stamp lookup
 *     (`isModuleRun`) are the mocked boundary — both proven against real components in
 *     `module.pg.test.ts` / `live.test.ts`. Which engine ran is read from which one was called.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENT_GRAPH_MODULE = 'false';
process.env.AGENT_GRAPH_MODULE_DOMAINS = 'test';

const moduleRuns: { runId: string; domain: string; resume: boolean }[] = [];
const stamped = new Set<string>();
const broken = new Set<string>();
let moduleDown = false;
mock.module(new URL('./os-run.ts', import.meta.url).href, {
  namedExports: {
    isModuleRun: async (runId: string) => {
      if (broken.has(runId)) throw new Error('agent_runs unreachable');
      return stamped.has(runId);
    },
    runOsTeamOnModule: async (input: { runId: string; sys: { system: { domain: string } }; task?: string }) => {
      if (moduleDown) throw new Error('module engine unavailable');
      moduleRuns.push({ runId: input.runId, domain: input.sys.system.domain, resume: input.task === undefined });
      stamped.add(input.runId);
      return { engine: 'module', runId: input.runId, path: ['analyst'], finalText: 'module answer', reachedEnd: true, parked: false, interrupted: false, heldApprovals: [], values: {}, module: { digest: 'd', commit: null }, runs: [], failed: false, checkpointer: 'memory' };
    },
    ensureAgentModuleReady: async () => 'off',
    moduleStores: async () => { throw new Error('not used'); },
    loadModuleForRun: async () => { throw new Error('not used'); },
  },
});

const { parseSystem, serializeSystem } = await import('@tabs/agents/lib/system-schema');
const { runOsTeam } = await import('@tabs/agents/lib/build/agentic-graph-server');

type LlmCall = import('@core/runtime/agentic').LlmCall;
type OsToolDeps = import('@tabs/agents/lib/build/os-tools').OsToolDeps;

const yamlIn = (domain: string) => serializeSystem(parseSystem({
  version: '1',
  system: { name: `Team ${domain}`, domain, visibility: 'Personal' },
  runtime: 'langgraph',
  entrypoint: 'analyst',
  grants: { tools: ['search_knowledge'] },
  agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
}));
const userIn = (domain: string) => ({ id: 'u1', name: 'U', domains: [domain], role: 'creator' as const });

let v1Calls = 0;
const v1Llm: LlmCall = async (req) => {
  v1Calls += 1;
  if (!req.tools || req.tools.length === 0) return { content: 'plan', toolCalls: [] };
  return { content: 'v1 answer', toolCalls: [] };
};
const toolDeps = {
  enqueue: (() => ({})) as unknown as OsToolDeps['enqueue'],
  handleRpc: (async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })) as unknown as OsToolDeps['handleRpc'],
  trace: (async () => ({})) as unknown as OsToolDeps['trace'],
} as OsToolDeps;

async function runIn(domain: string, runId: string, resume = false) {
  const before = { v1: v1Calls, module: moduleRuns.length };
  const res = await runOsTeam({ runId, user: userIn(domain), yaml: yamlIn(domain), systemId: `sys-${domain}`, messages: [{ role: 'user', content: 'go' }], llm: v1Llm, toolDeps, maxIterations: 2, ...(resume ? { resume: true } : {}) });
  return { res, onModule: moduleRuns.length > before.module, onV1: v1Calls > before.v1 };
}

test('flag OFF (the rollback): a parked MODULE run still resumes on the module; new runs and v1 runs stay on v1', async () => {
  const n = await runIn('test', 'off-new-1');
  assert.equal(n.onModule, false, 'a new run is v1 with the flag off, even in an allowed domain');
  assert.equal(n.onV1, true);
  stamped.add('off-parked-module');
  const r = await runIn('test', 'off-parked-module', true);
  assert.equal(r.onModule, true, 'the stamped run resumes on the module');
  assert.equal(r.onV1, false, 'and never on v1');
  assert.equal(moduleRuns.at(-1)?.resume, true);
});

test('negative twin: the module engine unavailable on a stamped resume FAILS the resume — no switch to v1', async () => {
  stamped.add('off-parked-down');
  moduleDown = true;
  const v1Before = v1Calls;
  try {
    await assert.rejects(runIn('test', 'off-parked-down', true), /module engine unavailable/);
  } finally {
    moduleDown = false;
  }
  assert.equal(v1Calls, v1Before, 'the v1 engine never ran');
});

test('negative twin: a stamp lookup that fails FAILS the resume — no guess at the engine', async () => {
  broken.add('off-unreadable');
  const v1Before = v1Calls;
  const modBefore = moduleRuns.length;
  await assert.rejects(runIn('sales', 'off-unreadable', true), /unreachable/);
  assert.equal(v1Calls, v1Before);
  assert.equal(moduleRuns.length, modBefore);
});
