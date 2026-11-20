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

function osDeps(runId: string, extra: Partial<OsAgentDeps> = {}, rpcText = '{"ok":true}', rpcIsError = false): OsAgentDeps {
  const deps: OsToolDeps = {
    enqueue: (() => { throw new Error('nothing is held'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (_u: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id ?? 1, result: { ...(rpcIsError ? { isError: true } : {}), content: [{ type: 'text', text: rpcText }] } })) as unknown as OsToolDeps['handleRpc'],
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

test('trace spans: one span per agent visit, each model call — the supervisor route included — in its llm span, sent as traceparent', { skip }, async () => {
  await stub.script(SCRIPT);
  const { observer, log, spanIds } = recordingObserver();
  const tracer = moduleTracer(observer);
  const before = (await stub.stats()).total;
  const traced = (a: { id: string }) => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false, fetch: tracer.fetchFor('route', a.id) });
  const r = await run(`trace-${Date.now()}`, osDeps('trace', { tracer, modelFor: traced }), undefined, tracer.spans);
  assert.equal(r.reachedEnd, true);
  assert.deepEqual(log, [
    'span agent.lead',
    'llm.lead tools=0',
    'end agent.lead',
    'span route.lead',
    'llm.route.lead tools=0',
    'end route.lead',
    'span agent.researcher',
    'llm.researcher tools=6',
    'tool.search_knowledge',
    'llm.researcher tools=6',
    'tool.query_data',
    'llm.researcher tools=6',
    'end agent.researcher',
    'span route.lead',
    'llm.route.lead tools=0',
    'end route.lead',
  ]);
  // EVERY model call carried its span as W3C traceparent and the minted call id — the gateway's join keys.
  const reqs = ((await (await fetch(stub.url.replace(/\/v1$/, '') + '/__stub/requests')).json()) as { requests: { headers: Record<string, string> }[] }).requests.slice(before);
  assert.equal(reqs.length, SCRIPT.length);
  for (const q of reqs) {
    const m = /^00-a{32}-([0-9a-f]{16})-01$/.exec(q.headers.traceparent ?? '');
    assert.ok(m && spanIds.includes(m[1]), `untraced model call: ${JSON.stringify(q.headers)}`);
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

test('model call limit (stock, exitBehavior error): the visit FAILS with model_call_limit — never an ok answer; twin without the limit runs on', { skip }, async () => {
  await stub.script(LOOP);
  const events: string[] = [];
  const limited = await run(`limit-${Date.now()}`, osDeps('limit', { limits: { modelCalls: 3, toolCalls: 50 } }), { onNodeComplete: (e) => events.push(`${e.node} ${e.status}`) });
  assert.equal(limited.failed, true);
  assert.equal(limited.reachedEnd, false);
  assert.equal(limited.failure?.node, 'researcher');
  assert.equal(limited.failure?.code, 'model_call_limit');
  assert.match(limited.failure?.reason ?? '', /limit/i);
  assert.deepEqual(events, ['lead ok', 'researcher failed']);
  assert.doesNotMatch(limited.finalText, /limit/i, 'the limit is not the team answer');
  const visit = limited.runs.find((x) => x.node === 'researcher')!;
  assert.equal(visit.status, 'failed');
  assert.match(visit.error ?? '', /^model_call_limit: /);

  await stub.script(LOOP);
  const unlimited = await run(`nolimit-${Date.now()}`, osDeps('nolimit'));
  assert.equal(unlimited.failed, false);
  assert.equal(unlimited.runs.find((x) => x.node === 'researcher')!.result.steps.length, 8, 'without the limit the agent runs all eight rounds');
});

test('tool call limit (stock, exitBehavior error): FAILS with tool_call_limit — also when the model makes parallel calls at the limit', { skip }, async () => {
  await stub.script(LOOP);
  const serial = await run(`toollimit-${Date.now()}`, osDeps('toollimit', { limits: { modelCalls: 50, toolCalls: 2 } }));
  assert.equal(serial.failed, true);
  assert.deepEqual([serial.failure?.node, serial.failure?.code], ['researcher', 'tool_call_limit']);

  // Two tool calls in ONE model turn past the limit (with `end` the stock middleware throws an untyped Error here).
  await stub.script([
    { content: 'Delegating.' },
    { tool_calls: [{ name: 'route', arguments: { next: 'researcher' } }] },
    { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'a' } }, { name: 'search_knowledge', arguments: { query: 'b' } }] },
    { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'c' } }, { name: 'query_data', arguments: { sql: 'select 1' } }] },
    { content: 'done' },
    { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
  ]);
  const parallel = await run(`parallel-${Date.now()}`, osDeps('parallel', { limits: { modelCalls: 50, toolCalls: 3 } }));
  assert.equal(parallel.failed, true, JSON.stringify(parallel.failure));
  assert.deepEqual([parallel.failure?.node, parallel.failure?.code], ['researcher', 'tool_call_limit']);
});

test('onNodeComplete reports the real status: a refused tool call makes the visit denied, as v1 does', { skip }, async () => {
  await stub.script([
    { content: 'Delegating.' },
    { tool_calls: [{ name: 'route', arguments: { next: 'researcher' } }] },
    { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'payroll' } }] },
    { content: 'I was not allowed to read it.' },
    { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
  ]);
  const events: string[] = [];
  // The governed door refuses the call with the typed policy envelope (as OPA/DLS refusals come back).
  const refusal = JSON.stringify({ error: { code: 'forbidden', reason: 'not granted to this system' } });
  const r = await run(`denied-${Date.now()}`, osDeps('denied', {}, refusal, true), {
    onStep: (e) => events.push(`step ${e.step.tool} error=${e.step.isError}`),
    onNodeComplete: (e) => events.push(`${e.node} ${e.status}`),
  });
  assert.deepEqual(events, ['lead ok', 'step search_knowledge error=true', 'researcher denied']);
  assert.equal(r.runs.find((x) => x.node === 'researcher')?.status, 'denied');
});

test('the OS preamble (rules + grant brief) reaches every agent model call; the twin without it does not', { skip }, async () => {
  const bodies: string[] = [];
  const recording = (_a: { id: string }) => requireGatewayChatModel({
    model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false,
    fetch: async (url, init) => { if (typeof init?.body === 'string') bodies.push(init.body); return globalThis.fetch(url, init); },
  });
  const PREAMBLE = 'OS RULES (test): act only through your granted tools. GRANTED: search_knowledge, query_data.';
  await stub.script(SCRIPT);
  await run(`preamble-${Date.now()}`, osDeps('preamble', { modelFor: recording, preamble: PREAMBLE }));
  const agentCalls = bodies.map((b) => JSON.parse(b) as { messages: { role: string; content: unknown }[]; tool_choice?: unknown }).filter((b) => !b.tool_choice || JSON.stringify(b.tool_choice).indexOf('route') < 0);
  assert.ok(agentCalls.length >= 3);
  for (const b of agentCalls) {
    const system = b.messages.filter((m) => m.role === 'system').map((m) => JSON.stringify(m.content)).join(' ');
    assert.match(system, /OS RULES \(test\)/, 'every agent call carries the preamble');
    assert.match(system, /# (lead|researcher)/, '...after the agent\'s own prompt');
  }
  bodies.length = 0;
  await stub.script(SCRIPT);
  await run(`nopreamble-${Date.now()}`, osDeps('nopreamble', { modelFor: recording }));
  assert.ok(bodies.every((b) => !b.includes('OS RULES (test)')));
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

test('the summary call carries its trace span too (traceparent on the summariser request)', { skip }, async () => {
  const { observer, log } = recordingObserver();
  const tracer = moduleTracer(observer);
  const summaryModel = (a: { id: string }) => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false, fetch: tracer.fetchFor('summary', a.id) });
  const modelFor = (a: { id: string }) => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false, fetch: tracer.fetchFor('route', a.id) });
  await stub.script(SUMMARY_SCRIPT);
  const before = (await stub.stats()).total;
  const r = await run(`sumtrace-${Date.now()}`, osDeps('sumtrace', { tracer, modelFor, context: { summaryModel, maxInputTokens: () => 200, keepMessages: 2, keepToolResults: 10 } }, 'y'.repeat(800)), undefined, tracer.spans);
  assert.equal(r.finalText, 'Found it.');
  assert.ok(log.includes('span summary.researcher') && log.includes('llm.summary.researcher tools=0'), log.join(' | '));
  const reqs = ((await (await fetch(stub.url.replace(/\/v1$/, '') + '/__stub/requests')).json()) as { requests: { headers: Record<string, string> }[] }).requests.slice(before);
  assert.equal(reqs.length, SUMMARY_SCRIPT.length);
  assert.ok(reqs.every((q) => /^00-a{32}-[0-9a-f]{16}-01$/.test(q.headers.traceparent ?? '')), 'every call — agent, route, summary — carries traceparent');
});

test('summarisation (stock summarizationMiddleware): past the window trigger the model is asked for a summary before the agent continues; twin without it answers with the summary text', { skip }, async () => {
  const summaryModel = () => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false });
  await stub.script(SUMMARY_SCRIPT);
  const r = await run(`summary-${Date.now()}`, osDeps('summary', { context: { summaryModel, maxInputTokens: () => 200, keepMessages: 2, keepToolResults: 10 } }, 'y'.repeat(800)));
  assert.equal(r.reachedEnd, true);
  assert.equal(r.finalText, 'Found it.', 'the agent answered after the summary call took the SUMMARY reply');
  assert.equal((await stub.stats()).cursor, SUMMARY_SCRIPT.length, 'every scripted reply was used: one of them by the summary call');
  const msgs = r.values.messages as { type?: string; content?: unknown }[];
  assert.ok(!msgs.some((m) => m.type === 'ai' && /SUMMARY/.test(String(m.content))), 'the summary never became an agent answer');
  // FORMAT 2, behaviourally: the agent's own summary replaced turns in ITS window only. The team
  // transcript still holds the task exactly once, the 800-character tool result and the answer,
  // and no summary message. (With the old `slice(state.messages.length)` this fails.)
  assert.equal(msgs.filter((m) => m.type === 'human' && m.content === 'How many orders?').length, 1, 'the task, once');
  assert.ok(msgs.some((m) => m.type === 'tool' && String(m.content) === 'y'.repeat(800)), 'the tool result survives the summary');
  assert.ok(!msgs.some((m) => /Here is a summary of the conversation/.test(String(m.content))), 'no summary in the team transcript');
  assert.deepEqual(msgs.map((m) => m.type), ['human', 'ai', 'human', 'ai', 'tool', 'ai'], 'the transcript in order: task, lead, brief, call, result, answer');

  // Twin: without the middleware there is no summary call, so the agent's next answer IS that reply.
  await stub.script(SUMMARY_SCRIPT);
  const twin = await run(`nosummary-${Date.now()}`, osDeps('nosummary', {}, 'y'.repeat(800)));
  assert.ok((twin.values.messages as { type?: string; content?: unknown }[]).some((m) => m.type === 'ai' && /SUMMARY: searched once\./.test(String(m.content))));
});
