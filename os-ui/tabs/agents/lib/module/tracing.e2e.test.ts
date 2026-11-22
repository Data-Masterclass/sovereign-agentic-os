/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b tracing e2e — a module run in the REAL Langfuse (3.194.1) through the REAL gateway
 *             (LiteLLM 1.109.1, `langfuse_otel`), with the ONE writer (WP-31)
 * USER STORY: As the owner I want a team that runs from its `graph.mjs` to appear in Langfuse like
 *             every run: one trace, the agent visit as a span, one `llm.<agent>` span per model call
 *             that the gateway's generation is joined to, the governed tool call as a tool
 *             observation, and the runner and system session on the trace.
 * ARCHITECTURE:
 *   - Stack: `tests/langfuse/compose.yaml` (the same as `engine/tracing.e2e.test.ts`). Skipped
 *     unless `TRACING_E2E=1`. The model behind LiteLLM is the WP-02 harness's scripted stub
 *     (`tests/e2e/kind/model-stub/stub.py`) on `STUB_MODEL_PORT`.
 *   - The run is the module path: a real git commit → hash check → `createOsAgent` with
 *     `moduleTracer(observe)` inside `withRunTrace` → `runAgentModule`; models via
 *     `requireGatewayChatModel` (ChatOpenAI → LiteLLM).
 *   - Assertions read `GET /api/public/traces/<id>`, Langfuse's own view.
 *   - NEGATIVE TWIN: the same run without the tracer leaves the gateway's generations unjoined (no
 *     `llm.<agent>` span), and the contract fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = process.env.TRACING_E2E === '1';
const LANGFUSE = process.env.LANGFUSE_E2E_URL ?? `http://127.0.0.1:${process.env.LANGFUSE_E2E_PORT ?? '13031'}`;
const LITELLM = process.env.LITELLM_E2E_URL ?? `http://127.0.0.1:${process.env.LITELLM_E2E_PORT ?? '14031'}`;
const STUB_PORT = Number(process.env.STUB_MODEL_PORT ?? '18931');
const PK = 'pk-lf-e2e-public';
const SK = 'sk-lf-e2e-secret';
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');
process.env.LANGFUSE_URL = LANGFUSE;
process.env.LANGFUSE_PUBLIC_KEY = PK;
process.env.LANGFUSE_SECRET_KEY = SK;
process.env.LITELLM_URL = LITELLM;

const { MemorySaver } = await import('@langchain/langgraph');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { commitTree, openOrInit } = await import('@core/infra/git-store');
const { grantedToolExecutor, grantedToolSpecs } = await import('@tabs/agents/lib/build/os-tools');
const { holdDecisionFor } = await import('@tabs/agents/lib/build/hold');
const { memoryApprovalPort } = await import('@tabs/agents/lib/engine/approval-port');
const { memoryToolCallLedger, withToolCallLedger } = await import('@tabs/agents/lib/engine/tool-call-ledger');
const { FIXTURE_USER, SHAPE_SINGLE_READ_YAML } = await import('@tabs/agents/lib/engine/parity-harness');
const { generateAgentModule } = await import('@tabs/agents/lib/module/generate');
const { hostModuleInputs } = await import('@tabs/agents/lib/module/versions');
const { loadAgentModule, readCommittedModule } = await import('@core/adapters/agent-module/load');
const { createOsAgent, memoryHoldStore } = await import('@tabs/agents/lib/module/os-agent');
const { memoryModuleRunStamps, runAgentModule } = await import('@tabs/agents/lib/module/run');
const { moduleTracer } = await import('@tabs/agents/lib/module/observe');
const { requireGatewayChatModel } = await import('@core/adapters/litellm/chat-model');
const { withRunTrace, flushLangfuse, langfuseTraceId } = await import('@core/infra/langfuse');
type OsToolDeps = import('@tabs/agents/lib/build/os-tools').OsToolDeps;

const STUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../tests/e2e/kind/model-stub/stub.py');
const SYSTEM_ID = 'sys-e2e-module';
const DIR = 'agents/reader';
const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
const SCRIPT = [
  { reply: { content: '', tool_calls: [{ name: 'search_knowledge', arguments: { query: 'state of sales' } }] } },
  { reply: { content: 'Sales are on track.' } },
];

async function startStub() {
  const proc = spawn('python3', ['-I', STUB], { env: { ...process.env, PORT: String(STUB_PORT) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${STUB_PORT}`;
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    script: async () => { await fetch(`${base}/__stub/script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: SCRIPT }) }); },
    calls: async () => ((await (await fetch(`${base}/__stub/stats`)).json()) as { counts: { chat?: number } }).counts.chat ?? 0,
    stop: () => proc.kill(),
  };
}

async function committedModule() {
  const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53b-trace-'));
  await openOrInit('sales', { reposDir });
  const expected = generateAgentModule({ id: SYSTEM_ID.replace(/-/g, '_'), slug: 'reader', sys, ...hostModuleInputs() });
  const { sha } = await commitTree('sales', new Map([...expected.files.entries()].map(([p, c]) => [`${DIR}/${p}`, c])), { reposDir, author: { name: 'os', email: 'os@example.invalid' }, message: 'agents' });
  const at = await readCommittedModule('sales', DIR, sha, { reposDir });
  return loadAgentModule({ committed: at.files, expected: expected.files, commit: sha, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53b-trace-cache-')) });
}

async function tracedModuleRun(runId: string, opts: { tracer: boolean }) {
  const loaded = await committedModule();
  const deps: OsToolDeps = {
    enqueue: (() => { throw new Error('nothing is held'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (_u: unknown, req: { id?: number }) => ({ jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: '{"hits":[]}' }] } })) as unknown as OsToolDeps['handleRpc'],
    trace: (async () => undefined) as unknown as OsToolDeps['trace'],
  };
  const caller = { userId: FIXTURE_USER.id, domain: 'sales', systemId: SYSTEM_ID, tab: 'agents', runId, env: 'test' as const };
  const r = await withRunTrace(
    { runId, systemId: SYSTEM_ID, systemName: sys.system.name, userId: FIXTURE_USER.id, domain: 'sales', task: 'How are sales?', environment: 'test', principal: `os-${SYSTEM_ID}`, engine: 'langgraph-module' },
    async (observe) => {
      const tracer = opts.tracer ? moduleTracer(observe) : undefined;
      const graph = createOsAgent(loaded.module, {
        modelFor: () => requireGatewayChatModel({ model: 'sovereign-worker', caller, writeSystem: false }),
        specs: grantedToolSpecs(FIXTURE_USER, sys),
        executor: withToolCallLedger(grantedToolExecutor(FIXTURE_USER, sys, SYSTEM_ID, deps, { holdAt: 'node' }), memoryToolCallLedger()),
        decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
        holds: memoryHoldStore(),
        threadId: runId,
        checkpointer: new MemorySaver(),
        ...(tracer ? { tracer } : {}),
      });
      const out = await runAgentModule({
        graph: graph as never,
        runId,
        owner: { systemId: SYSTEM_ID, userId: FIXTURE_USER.id, domain: 'sales' },
        task: 'How are sales?',
        approvals: memoryApprovalPort(),
        stamps: memoryModuleRunStamps(),
        runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
        agent: `os-${SYSTEM_ID}`,
        module: { digest: loaded.digest, commit: loaded.commit },
        ...(tracer ? { spans: tracer.spans } : {}),
      });
      observe.finish({ reachedEnd: out.reachedEnd, parked: out.parked, interrupted: out.interrupted, failed: false, path: out.path, finalChars: out.finalText.length, stepsUsed: out.path.length });
      return out;
    },
  );
  await flushLangfuse();
  return r;
}

type Observation = { id: string; type: string; name: string; parentObservationId: string | null; endTime?: string | null; usage?: { total?: number }; metadata?: Record<string, unknown> };
type Trace = { id: string; userId: string | null; sessionId: string | null; observations: Observation[] };

async function settled(traceId: string, generations: number): Promise<Trace> {
  const deadline = Date.now() + 120_000;
  let last: Trace | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${LANGFUSE}/api/public/traces/${traceId}`, { headers: { authorization: AUTH } });
    last = res.ok ? ((await res.json()) as Trace) : null;
    const gens = last?.observations.filter((o) => o.type === 'GENERATION') ?? [];
    if (last && last.userId && gens.length >= generations && last.observations.some((o) => o.name === 'run.result') && !last.observations.some((o) => o.type !== 'EVENT' && !o.endTime)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail(`trace ${traceId} incomplete: ${JSON.stringify(last?.observations.map((o) => `${o.type}:${o.name}`))}`);
}

/** The module-run trace contract, from Langfuse's own API. */
function assertModuleTrace(t: Trace, calls: number): void {
  const gens = t.observations.filter((o) => o.type === 'GENERATION');
  assert.equal(gens.length, calls, 'one generation per model call (the gateway is the only writer of generations)');
  const llm = t.observations.filter((o) => o.name === 'llm.reader');
  assert.equal(llm.length, calls, 'one llm.<agent> span per model call');
  const byCall = new Map(llm.map((o) => [String((o.metadata as { litellm_call_id?: string } | undefined)?.litellm_call_id ?? ''), o]));
  for (const g of gens) {
    const reported = String(((g.metadata as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {})['litellm.call_id'] ?? '');
    assert.ok(reported && byCall.has(reported), `generation ${g.id} is joined to its llm.reader span by litellm.call_id`);
  }
  const agent = t.observations.find((o) => o.name === 'agent.reader');
  assert.ok(agent, 'the agent visit is a span');
  for (const o of llm) assert.equal(o.parentObservationId, agent!.id, 'model calls nest under the agent visit');
  const tool = t.observations.find((o) => o.type === 'TOOL' && o.name === 'tool.search_knowledge');
  assert.ok(tool && tool.parentObservationId === agent!.id, 'the governed tool call is a tool observation under the visit');
  assert.equal(t.userId, FIXTURE_USER.id);
  assert.equal(t.sessionId, `system:${SYSTEM_ID}`);
}

test('MODULE TRACING E2E: one trace, agent span, one joined llm span per call, the tool observation, user and session', { skip: !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up' }, async () => {
  const stub = await startStub();
  try {
    await stub.script();
    const runId = `run_${randomUUID()}`;
    const r = await tracedModuleRun(runId, { tracer: true });
    assert.equal(r.reachedEnd, true);
    assert.equal(r.finalText, 'Sales are on track.');
    const calls = await stub.calls();
    assert.equal(calls, 2);
    assertModuleTrace(await settled(await langfuseTraceId(runId), calls), calls);
  } finally {
    stub.stop();
  }
});

test('MODULE TRACING E2E — NEGATIVE TWIN: without the tracer the generations are not joined and the contract fails', { skip: !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up' }, async () => {
  const stub = await startStub();
  try {
    await stub.script();
    const runId = `run_${randomUUID()}`;
    await tracedModuleRun(runId, { tracer: false });
    const calls = await stub.calls();
    const t = await settled(await langfuseTraceId(runId), 0);
    assert.throws(() => assertModuleTrace(t, calls), /one generation per model call|one llm.<agent> span/);
  } finally {
    stub.stop();
  }
});

// ---------------------------------------------------------------- route + summary (WP-53c) --

const TEAM_YAML = `version: '1'
system: { name: E2E team, domain: sales, visibility: Personal }
safety_preset: read-only
entrypoint: lead
state: { channels: { messages: add_messages } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: lead, role: Routes, agent_md: '# lead', memory_md: '', tools: [], members: [reader] }
  - { id: reader, role: Reads, agent_md: '# reader', memory_md: '', tools: [search_knowledge] }
edges:
  - { from: lead, to: reader, type: supervise }
`;
const TEAM_SCRIPT = [
  { reply: { content: 'Delegating.' } },
  { reply: { content: '', tool_calls: [{ name: 'route', arguments: { next: 'reader', brief: 'look it up' } }] } },
  { reply: { content: '', tool_calls: [{ name: 'search_knowledge', arguments: { query: 'sales' } }] } },
  // The 800-character result crosses 70 % of the 200-token window: the stock summariser's call.
  { reply: { content: 'SUMMARY: searched once.' } },
  { reply: { content: 'Sales are on track.' } },
  { reply: { content: '', tool_calls: [{ name: 'route', arguments: { next: 'END' } }] } },
];

test('MODULE TRACING E2E — the supervisor route and the summariser calls are joined too: one generation per call, each joined to its llm.<kind>.<agent> span', { skip: !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up' }, async () => {
  const stub = await startStub();
  try {
    await fetch(`http://127.0.0.1:${STUB_PORT}/__stub/script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: TEAM_SCRIPT }) });
    const teamSys = parseSystem(TEAM_YAML);
    const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53c-trace-'));
    await openOrInit('sales', { reposDir });
    const expected = generateAgentModule({ id: 'sys_e2e_team', slug: 'team', sys: teamSys, ...hostModuleInputs() });
    const { sha } = await commitTree('sales', new Map([...expected.files.entries()].map(([p, c]) => [`agents/team/${p}`, c])), { reposDir, author: { name: 'os', email: 'os@example.invalid' }, message: 'agents' });
    const at = await readCommittedModule('sales', 'agents/team', sha, { reposDir });
    const loaded = await loadAgentModule({ committed: at.files, expected: expected.files, commit: sha, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53c-trace-cache-')) });
    const runId = `run_${randomUUID()}`;
    const caller = { userId: FIXTURE_USER.id, domain: 'sales', systemId: 'sys-e2e-team', tab: 'agents', runId, env: 'test' as const };
    const deps: OsToolDeps = {
      enqueue: (() => { throw new Error('nothing is held'); }) as unknown as OsToolDeps['enqueue'],
      handleRpc: (async (_u: unknown, req: { id?: number }) => ({ jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: 'y'.repeat(800) }] } })) as unknown as OsToolDeps['handleRpc'],
      trace: (async () => undefined) as unknown as OsToolDeps['trace'],
    };
    const r = await withRunTrace(
      { runId, systemId: 'sys-e2e-team', systemName: 'E2E team', userId: FIXTURE_USER.id, domain: 'sales', task: 'How are sales?', environment: 'test', principal: 'os-sys-e2e-team', engine: 'langgraph-module' },
      async (observe) => {
        const tracer = moduleTracer(observe);
        const graph = createOsAgent(loaded.module, {
          modelFor: (a) => requireGatewayChatModel({ model: 'sovereign-worker', caller, writeSystem: false, fetch: tracer.fetchFor('route', a.id) }),
          specs: grantedToolSpecs(FIXTURE_USER, teamSys),
          executor: withToolCallLedger(grantedToolExecutor(FIXTURE_USER, teamSys, 'sys-e2e-team', deps, { holdAt: 'node' }), memoryToolCallLedger()),
          decide: (tool) => holdDecisionFor(teamSys.safetyPreset, tool),
          holds: memoryHoldStore(),
          threadId: runId,
          checkpointer: new MemorySaver(),
          tracer,
          context: {
            summaryModel: (a) => requireGatewayChatModel({ model: 'sovereign-worker', caller, writeSystem: false, fetch: tracer.fetchFor('summary', a.id) }),
            maxInputTokens: () => 200,
            keepMessages: 2,
            keepToolResults: 10,
          },
        });
        const out = await runAgentModule({
          graph: graph as never,
          runId,
          owner: { systemId: 'sys-e2e-team', userId: FIXTURE_USER.id, domain: 'sales' },
          task: 'How are sales?',
          approvals: memoryApprovalPort(),
          stamps: memoryModuleRunStamps(),
          runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
          agent: 'os-sys-e2e-team',
          module: { digest: loaded.digest, commit: loaded.commit },
          spans: tracer.spans,
          recursionLimit: 500,
        });
        observe.finish({ reachedEnd: out.reachedEnd, parked: out.parked, interrupted: out.interrupted, failed: out.failed, path: out.path, finalChars: out.finalText.length, stepsUsed: out.path.length });
        return out;
      },
    );
    await flushLangfuse();
    assert.equal(r.reachedEnd, true);
    assert.equal(r.finalText, 'Sales are on track.');
    const calls = await stub.calls();
    assert.equal(calls, TEAM_SCRIPT.length, 'six model calls: lead, route, reader, summary, reader, route');
    const t = await settled(await langfuseTraceId(runId), calls);
    const gens = t.observations.filter((o) => o.type === 'GENERATION');
    assert.equal(gens.length, calls, 'one generation per model call, the gateway the only writer');
    const llm = t.observations.filter((o) => o.name.startsWith('llm.'));
    assert.deepEqual(llm.map((o) => o.name).sort(), ['llm.lead', 'llm.reader', 'llm.reader', 'llm.route.lead', 'llm.route.lead', 'llm.summary.reader']);
    const byCall = new Map(llm.map((o) => [String((o.metadata as { litellm_call_id?: string } | undefined)?.litellm_call_id ?? ''), o]));
    for (const g of gens) {
      const reported = String(((g.metadata as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {})['litellm.call_id'] ?? '');
      assert.ok(reported && byCall.has(reported), `generation ${g.id} (call ${reported}) is joined to an llm span`);
    }
    for (const kind of ['route.lead', 'summary.reader']) assert.ok(t.observations.some((o) => o.name === kind), `${kind} span present`);
  } finally {
    stub.stop();
  }
});

