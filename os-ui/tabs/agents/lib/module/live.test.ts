/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b — a module run's live events, run drill-down, trace spans, context management
 *             and per-agent call limit, against the real LangGraph/langchain and an OpenAI-compatible
 *             model over HTTP
 * USER STORY: As a builder I want the Run panel to show a team that runs from its `graph.mjs` the way
 *             it shows any run — which agent works, each tool step as it finishes, each agent's end
 *             and the drill-down — and as the owner I want each model call traced with the span id
 *             the gateway nests under, long transcripts summarised by the stock middleware and a
 *             runaway agent stopped by the stock call limit.
 * ARCHITECTURE:
 *   - The module is generated, committed to a real git repo, hash-verified and imported; the model
 *     is ChatOpenAI against the WP-02 harness's scripted stub (`tests/e2e/kind/model-stub/stub.py`),
 *     which records the request headers it receives (`GET /__stub/requests`).
 *   - Tracing: a recording `RunObserver` (the port the WP-31 writer implements) — what each span
 *     received; the real Langfuse round trip is `module/tracing.e2e.test.ts`.
 *   - Negative twins: without the tracer no `traceparent` reaches the model endpoint; without the
 *     call limit the looping agent runs past it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import type { RunObserver, SpanHandle } from '@core/infra/trace-port';
import type { LlmRequest } from '@core/runtime/agentic';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { memoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import { memoryToolCallLedger, withToolCallLedger } from '@tabs/agents/lib/engine/tool-call-ledger';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';
import { loadAgentModule, readCommittedModule } from '@core/adapters/agent-module/load';
import { createOsAgent, memoryHoldStore, type OsAgentDeps } from '@tabs/agents/lib/module/os-agent';
import { memoryModuleRunStamps, runAgentModule, type ModuleRunHooks } from '@tabs/agents/lib/module/run';
import { moduleTracer } from '@tabs/agents/lib/module/observe';
import { requireGatewayChatModel } from '@core/adapters/litellm/chat-model';
import { python3Available, startModelStub, type ModelStub, type StubReply } from '@tabs/agents/lib/module/fixtures/stub-model';

const skip = python3Available() ? false : 'python3 missing — the model stub cannot start';

const TEAM = `version: '1'
system: { name: Live team, domain: sales, visibility: Shared }
safety_preset: read-only
entrypoint: lead
state: { channels: { messages: add_messages } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, query_data], connections: [] }
agents:
  - { id: lead, role: Routes, agent_md: '# lead', memory_md: '', tools: [], members: [researcher] }
  - { id: researcher, role: Finds, agent_md: '# researcher', memory_md: '', tools: [search_knowledge, query_data] }
edges:
  - { from: lead, to: researcher, type: supervise }
`;
const SCRIPT: StubReply[] = [
  { content: 'Delegating.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'researcher', brief: 'find it' } }] },
  { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'orders' } }] },
  { tool_calls: [{ name: 'query_data', arguments: { sql: 'select 1' } }] },
  { content: 'Found 42.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
];

let stub: ModelStub;
let loaded: Awaited<ReturnType<typeof loadAgentModule>>;
const sys = parseSystem(TEAM);

before(async () => {
  if (skip) return;
  stub = await startModelStub();
  const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53b-live-'));
  await openOrInit('sales', { reposDir });
  const expected = generateAgentModule({ id: 'sys_live1', slug: 'live', sys, ...hostModuleInputs() });
  const { sha } = await commitTree('sales', new Map([...expected.files.entries()].map(([p, c]) => [`agents/live/${p}`, c])), { reposDir, author: { name: 'os', email: 'os@example.invalid' }, message: 'm' });
  const at = await readCommittedModule('sales', 'agents/live', sha, { reposDir });
  loaded = await loadAgentModule({ committed: at.files, expected: expected.files, commit: sha, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53b-live-cache-')) });
});
after(() => stub?.stop());

/** A recording observer: what each span and each model/tool call received. */
function recordingObserver() {
  const log: string[] = [];
  const spanIds: string[] = [];
  let n = 0;
  const observer: RunObserver = {
    traceId: 'a'.repeat(32),
    enabled: true,
    span(name) {
      const id = (n++).toString(16).padStart(16, '0');
      spanIds.push(id);
      log.push(`span ${name}`);
      const h: SpanHandle = {
        id,
        traceId: 'a'.repeat(32),
        llm: (inner, spanName) => async (req: LlmRequest) => {
          log.push(`${spanName} tools=${(req.tools ?? []).length}`);
          return inner({ ...req, observe: { traceId: 'a'.repeat(32), parentObservationId: id, callId: `call-${log.length}` } });
        },
        tool: async (call, _meta, run) => {
          log.push(`tool.${call.name}`);
          return run();
        },
        toolEvent: () => undefined,
        end: (status) => log.push(`end ${name}${status?.parked ? ' parked' : status?.error ? ' error' : ''}`),
      };
      return h;
    },
    finish: () => undefined,
    flush: async () => undefined,
  };
  return { observer, log, spanIds };
}

function osDeps(runId: string, extra: Partial<OsAgentDeps> = {}, rpcText = '{"ok":true}'): OsAgentDeps {
  const deps: OsToolDeps = {
    enqueue: (() => { throw new Error('nothing is held'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (_u: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: rpcText }] } })) as unknown as OsToolDeps['handleRpc'],
    trace: (async () => undefined) as unknown as OsToolDeps['trace'],
  };
  return {
    modelFor: () => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false }),
    specs: grantedToolSpecs(FIXTURE_USER, sys),
    executor: withToolCallLedger(grantedToolExecutor(FIXTURE_USER, sys, 'sys_live1', deps, { holdAt: 'node' }), memoryToolCallLedger()),
    decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
    holds: memoryHoldStore(),
    threadId: runId,
    checkpointer: new MemorySaver(),
    ...extra,
  };
}

async function run(runId: string, deps: OsAgentDeps, hooks?: ModuleRunHooks, spans?: ReturnType<typeof moduleTracer>['spans']) {
  return runAgentModule({
    graph: createOsAgent(loaded.module, deps) as never,
    runId,
    owner: { systemId: 'sys_live1', userId: FIXTURE_USER.id, domain: 'sales' },
    task: 'How many orders?',
    approvals: memoryApprovalPort(),
    stamps: memoryModuleRunStamps(),
    runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
    agent: 'os-sys_live1',
    module: { digest: loaded.digest, commit: loaded.commit },
    agentCount: loaded.module.TEAM.agents.length,
    modelOf: () => 'stub',
    // As runOsTeamOnModule sets it: room for every agent's own loop under the team's step budget.
    recursionLimit: 1_000,
    ...(hooks ? { hooks } : {}),
    ...(spans ? { spans } : {}),
  });
}

test('live events and the drill-down: node start, each tool step, node end — in order — and runs[] per visit', { skip }, async () => {
  await stub.script(SCRIPT);
  const events: string[] = [];
  const r = await run(`live-${Date.now()}`, osDeps('live'), {
    onNodeStart: (e) => events.push(`start ${e.node} ${e.index}/${e.total}`),
    onStep: (e) => events.push(`step ${e.node} #${e.index} ${e.step.tool} ${JSON.stringify(e.step.args)} error=${e.step.isError}`),
    onNodeComplete: (e) => events.push(`done ${e.node} ${e.status} ${JSON.stringify(e.finalText)}`),
  });
  assert.equal(r.reachedEnd, true);
  assert.deepEqual(events, [
    'start lead 0/2',
    'done lead ok "Delegating."',
    'start researcher 1/2',
    'step researcher #0 search_knowledge {"query":"orders"} error=false',
    'step researcher #1 query_data {"sql":"select 1"} error=false',
    'done researcher ok "Found 42."',
  ]);
  assert.deepEqual(r.runs.map((x) => [x.node, x.status, x.result.finalText, x.result.steps.map((s) => s.tool)]), [
    ['lead', 'ok', 'Delegating.', []],
    ['researcher', 'ok', 'Found 42.', ['search_knowledge', 'query_data']],
  ]);
  assert.deepEqual(r.runs[1].result.steps[0].args, { query: 'orders' });
});

test('trace spans: one span per agent visit, each model call in its llm span with the span id sent as traceparent, tools in the visit', { skip }, async () => {
  await stub.script(SCRIPT);
  const { observer, log, spanIds } = recordingObserver();
  const tracer = moduleTracer(observer);
  const before = (await stub.stats()).total;
  const r = await run(`trace-${Date.now()}`, osDeps('trace', { tracer }), undefined, tracer.spans);
  assert.equal(r.reachedEnd, true);
  assert.deepEqual(log, [
    'span agent.lead',
    'llm.lead tools=0',
    'end agent.lead',
    'span agent.researcher',
    'llm.researcher tools=6',
    'tool.search_knowledge',
    'llm.researcher tools=6',
    'tool.query_data',
    'llm.researcher tools=6',
    'end agent.researcher',
  ]);
  // The agent calls carried their span as W3C traceparent and the minted call id — the gateway's join keys.
  const reqs = ((await (await fetch(stub.url.replace(/\/v1$/, '') + '/__stub/requests')).json()) as { requests: { headers: Record<string, string> }[] }).requests.slice(before);
  const traced = reqs.filter((q) => q.headers.traceparent);
  assert.equal(traced.length, 4, 'every agent model call (not the supervisor route) carries traceparent');
  for (const q of traced) {
    const m = /^00-a{32}-([0-9a-f]{16})-01$/.exec(q.headers.traceparent);
    assert.ok(m && spanIds.includes(m[1]), q.headers.traceparent);
    assert.match(q.headers['x-litellm-call-id'] ?? '', /^call-\d+$/);
  }
});

test('negative twin: without the tracer no model call carries a traceparent', { skip }, async () => {
  await stub.script(SCRIPT);
  const before = (await stub.stats()).total;
  await run(`untraced-${Date.now()}`, osDeps('untraced'));
  const reqs = ((await (await fetch(stub.url.replace(/\/v1$/, '') + '/__stub/requests')).json()) as { requests: { headers: Record<string, string> }[] }).requests.slice(before);
  assert.equal(reqs.filter((q) => q.headers.traceparent).length, 0);
});

const LOOP: StubReply[] = [
  { content: 'Delegating.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'researcher' } }] },
  ...Array.from({ length: 8 }, (_, i) => ({ tool_calls: [{ name: 'search_knowledge', arguments: { query: `again ${i}` } }] })),
  { content: 'done' },
  { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
];

test('per-agent call limit (stock modelCallLimitMiddleware): a looping agent stops at the limit; its twin without the limit runs on', { skip }, async () => {
  await stub.script(LOOP);
  const limited = await run(`limit-${Date.now()}`, osDeps('limit', { limits: { modelCalls: 3, toolCalls: 50 } }));
  const researcher = limited.runs.find((x) => x.node === 'researcher')!;
  assert.equal(researcher.result.steps.length, 3, 'three model calls, three tool rounds, then the limit ends the visit');
  const msgs = (limited.values.messages as { type?: string; content?: unknown }[]).map((m) => String(m.content));
  assert.ok(msgs.some((t) => /limit/i.test(t)), 'the limit leaves a readable note in the transcript');

  await stub.script(LOOP);
  const unlimited = await run(`nolimit-${Date.now()}`, osDeps('nolimit'));
  assert.equal(unlimited.runs.find((x) => x.node === 'researcher')!.result.steps.length, 8, 'without the limit the agent runs all eight rounds');
});

const SUMMARY_SCRIPT: StubReply[] = [
  { content: 'Delegating.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'researcher' } }] },
  { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'orders' } }] },
  // The 800-character tool result crosses 70 % of the 200-token window: before the next model call
  // the stock middleware asks the model for a summary — this reply is that summary.
  { content: 'SUMMARY: searched once.' },
  { content: 'Found it.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
];

test('summarisation (stock summarizationMiddleware): past the window trigger the model is asked for a summary before the agent continues; twin without it answers with the summary text', { skip }, async () => {
  const summaryModel = () => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false });
  await stub.script(SUMMARY_SCRIPT);
  const r = await run(`summary-${Date.now()}`, osDeps('summary', { context: { summaryModel, maxInputTokens: () => 200, keepMessages: 2, keepToolResults: 10 } }, 'y'.repeat(800)));
  assert.equal(r.reachedEnd, true);
  assert.equal(r.finalText, 'Found it.', 'the agent answered after the summary call took the SUMMARY reply');
  assert.equal((await stub.stats()).cursor, SUMMARY_SCRIPT.length, 'every scripted reply was used: one of them by the summary call');
  const msgs = r.values.messages as { type?: string; content?: unknown }[];
  assert.ok(!msgs.some((m) => m.type === 'ai' && /SUMMARY/.test(String(m.content))), 'the summary never became an agent answer');

  // Twin: without the middleware there is no summary call, so the agent's next answer IS that reply.
  await stub.script(SUMMARY_SCRIPT);
  const twin = await run(`nosummary-${Date.now()}`, osDeps('nosummary', {}, 'y'.repeat(800)));
  assert.ok((twin.values.messages as { type?: string; content?: unknown }[]).some((m) => m.type === 'ai' && /SUMMARY: searched once\./.test(String(m.content))));
});
