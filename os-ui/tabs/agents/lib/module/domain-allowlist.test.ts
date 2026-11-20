/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53d — AGENT_GRAPH_MODULE_DOMAINS: the module path for the allowed domains only;
 *             a parked run resumes on the engine it started on whatever the allowlist says now
 * USER STORY: As the operator I want to switch the module path on for `test` only, see every other
 *             domain stay on today's engine, and change the allowlist without moving a parked run.
 * ARCHITECTURE:
 *   - `runOsTeam` — the ONE entry os-ui and the worker both call — with the environment set before
 *     import (`AGENT_GRAPH_MODULE=true`, `AGENT_GRAPH_MODULE_DOMAINS=test`). The v1 engine runs for
 *     real on a scripted model; the module path's entry (`runOsTeamOnModule`) and its stamp lookup
 *     (`isModuleRun`) are the mocked boundary — both proven against real components in
 *     `module.pg.test.ts` / `live.test.ts`. Which engine ran is read from which one was called.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENT_GRAPH_MODULE = 'true';
process.env.AGENT_GRAPH_MODULE_DOMAINS = 'test';

const moduleRuns: { runId: string; domain: string; resume: boolean }[] = [];
const stamped = new Set<string>();
mock.module(new URL('./os-run.ts', import.meta.url).href, {
  namedExports: {
    isModuleRun: async (runId: string) => stamped.has(runId),
    runOsTeamOnModule: async (input: { runId: string; sys: { system: { domain: string } }; task?: string }) => {
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
const { moduleEnabledFor, engineForRun } = await import('@tabs/agents/lib/module/flag');
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

test('the allowlist: a system in `test` runs on the module path, a system in `sales` stays on v1', async () => {
  const t = await runIn('test', 'run-test-1');
  assert.equal(t.onModule, true);
  assert.equal(t.onV1, false);
  assert.equal(t.res.finalText, 'module answer');
  const s = await runIn('sales', 'run-sales-1');
  assert.equal(s.onModule, false);
  assert.equal(s.onV1, true);
  assert.match(s.res.finalText, /v1 answer/);
});

test('a run parked in one engine resumes in the same engine when the allowlist changes', async () => {
  // A module run started in `test` (stamped) — then the allowlist moves to `sales` only.
  await runIn('test', 'run-moved-1');
  assert.ok(stamped.has('run-moved-1'));
  assert.equal(await engineForRun({ resume: true, domain: 'test', runId: 'run-moved-1', isModuleRun: async (id) => stamped.has(id), domains: ['sales'] }), 'module', 'a stamped run resumes on the module even though its domain is no longer allowed');
  // A v1 run (no stamp) in `test` resumes on v1 even though `test` is allowed.
  assert.equal(await engineForRun({ resume: true, domain: 'test', runId: 'run-v1-parked', isModuleRun: async (id) => stamped.has(id) }), 'v1');
  // And through runOsTeam itself (allowlist `test` from the environment):
  stamped.add('run-sales-parked-on-module');
  const r = await runIn('sales', 'run-sales-parked-on-module', true);
  assert.equal(r.onModule, true, 'a sales run stamped on the module resumes there although sales is not allowed');
  assert.equal(moduleRuns.at(-1)?.resume, true);
});

test('moduleEnabledFor: the flag is the master switch; an empty list means NO domain, "*" every domain', () => {
  assert.equal(moduleEnabledFor('test'), true);
  assert.equal(moduleEnabledFor('sales'), false);
  assert.equal(moduleEnabledFor('sales', { enabled: true, domains: [] }), false);
  assert.equal(moduleEnabledFor('test', { enabled: true, domains: [] }), false);
  assert.equal(moduleEnabledFor('sales', { enabled: true, domains: ['*'] }), true);
  assert.equal(moduleEnabledFor('test', { enabled: false, domains: ['test'] }), false);
  assert.equal(moduleEnabledFor('test', { enabled: false, domains: ['*'] }), false);
});
