/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Tracing e2e on the REAL Langfuse server (3.194.1) and the REAL gateway (LiteLLM
 *             1.109.1, `langfuse_otel`, production callback settings) — WP-31/WP-32, design 05 §7 (v3 variant)
 * USER STORY: As the owner I want proof from Langfuse's own API that one agent run is one trace,
 *             that every model call appears exactly ONCE as a generation (the gateway's), nested
 *             under the run's own observation tree, and that the runner and the system session are
 *             on the trace — and that the test turns red the day a second writer comes back.
 * ARCHITECTURE:
 *   - Stack: `tests/langfuse/compose.yaml` (Langfuse's documented self-host compose, pinned to
 *     production versions, plus the production LiteLLM image). Skipped unless `TRACING_E2E=1`.
 *   - The run is the REAL engine (`runGraphEngine`) with the REAL model caller (`liteLlmCaller`)
 *     through LiteLLM; the model behind LiteLLM is the parity harness's scripted model served
 *     here as an OpenAI-compatible endpoint, so the run is deterministic.
 *   - Assertions read `GET /api/public/traces/<id>` — Langfuse's own view, never our exporter.
 *   - NEGATIVE TWIN: the same run with a second writer re-introduced (the deleted hand-written
 *     generation sender, POSTing to `/api/public/ingestion`) must make the same assertion fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const E2E = process.env.TRACING_E2E === '1';
const LANGFUSE = process.env.LANGFUSE_E2E_URL ?? `http://127.0.0.1:${process.env.LANGFUSE_E2E_PORT ?? '13031'}`;
const LITELLM = process.env.LITELLM_E2E_URL ?? `http://127.0.0.1:${process.env.LITELLM_E2E_PORT ?? '14031'}`;
const STUB_PORT = Number(process.env.STUB_MODEL_PORT ?? '18931');
const PK = 'pk-lf-e2e-public';
const SK = 'sk-lf-e2e-secret';
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');

// The writer and the gateway caller read these at import.
process.env.LANGFUSE_URL = LANGFUSE;
process.env.LANGFUSE_PUBLIC_KEY = PK;
process.env.LANGFUSE_SECRET_KEY = SK;
process.env.LITELLM_URL = LITELLM;

const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { compile } = await import('@tabs/agents/lib/langgraph-compile');
const { runGraphEngine } = await import('@tabs/agents/lib/engine/run');
const { memoryCheckpointer } = await import('@tabs/agents/lib/engine/checkpointer');
const { FIXTURE_TASK, SHAPE_SINGLE_READ_YAML, graphDeps, scriptedLlm } = await import('@tabs/agents/lib/engine/parity-harness');
const { liteLlmCaller } = await import('@core/runtime/runtime');
const { withRunTrace, flushLangfuse, langfuseTraceId, readTraceObservations } = await import('@core/infra/langfuse');
const { shapeTraceMetrics } = await import('@tabs/agents/lib/build/run-diagnostics');
type LlmCall = import('@core/runtime/agentic').LlmCall;
type LlmRequest = import('@core/runtime/agentic').LlmRequest;

// The gateway's span scope, read from the stack itself (gate rule 9 in
// scripts/check-litellm-model-info.mjs keeps tests/langfuse/compose.yaml equal to the chart).
const { readFileSync } = await import('node:fs');
const yaml = (await import('js-yaml')).default;
const COMPOSE = yaml.load(readFileSync(new URL('../../../../../tests/langfuse/compose.yaml', import.meta.url), 'utf8')) as { services: { litellm: { environment: Record<string, string> } } };
const SCOPE = COMPOSE.services.litellm.environment.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE ?? 'full';

const SYSTEM_ID = 'sys-e2e-trace';
const USER_ID = 'rae';

// ------------------------------------------------------------ scripted model --

/** The parity harness's scripted model, served as an OpenAI-compatible endpoint for LiteLLM. */
function startStubModel(): Promise<{ server: Server; calls: () => number }> {
  const script = scriptedLlm(FIXTURE_TASK);
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}') as { model: string; messages: LlmRequest['messages']; tools?: LlmRequest['tools'] };
        calls += 1;
        const out = await script({ model: body.model, messages: body.messages, tools: body.tools });
        const toolCalls = (out.toolCalls ?? []).map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'stub-model',
          choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: out.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '0.0.0.0', () => resolve({ server, calls: () => calls })));
}

// ------------------------------------------------------------- the second writer --

/**
 * The deleted hand-written generation sender, re-introduced ON PURPOSE for the negative twin: for
 * every model call it POSTs its own `generation-create` to the legacy ingestion endpoint, nested
 * under the same `llm.<node>` span the gateway nests under — exactly what the old observer did.
 */
function withSecondWriter(inner: LlmCall): LlmCall {
  return async (req) => {
    const out = await inner(req);
    if (req.observe) {
      await fetch(`${LANGFUSE}/api/public/ingestion`, {
        method: 'POST',
        headers: { authorization: AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ batch: [{ id: randomUUID(), type: 'generation-create', timestamp: new Date().toISOString(), body: { id: randomUUID(), traceId: req.observe.traceId, parentObservationId: req.observe.parentObservationId, name: 'llm.app-side', model: req.model, startTime: new Date().toISOString(), endTime: new Date().toISOString(), usage: { input: 10, output: 5, total: 15, unit: 'TOKENS' } } }] }),
      });
    }
    return out;
  };
}

// ------------------------------------------------------------------ the run --

async function tracedRun(runId: string, opts: { secondWriter?: boolean } = {}) {
  const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
  const gateway = liteLlmCaller({ userId: USER_ID, domain: sys.system.domain, systemId: SYSTEM_ID, tab: 'agents', runId, env: 'test' });
  const llm = opts.secondWriter ? withSecondWriter(gateway) : gateway;
  const result = await withRunTrace(
    { runId, systemId: SYSTEM_ID, systemName: sys.system.name, userId: USER_ID, domain: sys.system.domain, task: FIXTURE_TASK, environment: 'test', principal: `os-${SYSTEM_ID}` },
    (observe) => runGraphEngine({
      ir: compile(sys),
      deps: { ...graphDeps(sys, SYSTEM_ID, llm, { enqueued: [] }), observe },
      messages: [{ role: 'user', content: FIXTURE_TASK }],
      runId,
      checkpointer: memoryCheckpointer(),
    }),
  );
  await flushLangfuse();
  return result;
}

type Observation = { id: string; traceId: string; type: string; name: string; parentObservationId: string | null; endTime?: string | null; usage?: { total?: number }; calculatedTotalCost?: number; metadata?: Record<string, unknown> };
type Trace = { id: string; userId: string | null; sessionId: string | null; tags: string[]; observations: Observation[] };

/** Which ingested observations still lack their join key ('' when none). */
function joinKeysMissing(obs: Observation[]): string {
  const span = obs.filter((o) => o.name.startsWith('llm.') && typeof (o.metadata as { litellm_call_id?: unknown } | undefined)?.litellm_call_id !== 'string').length;
  const gen = obs.filter((o) => o.type === 'GENERATION' && !((o.metadata as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {})['litellm.call_id']).length;
  return span || gen ? `join keys (${span} llm span(s) without litellm_call_id, ${gen} generation(s) without litellm.call_id)` : '';
}

async function readTrace(traceId: string): Promise<Trace | null> {
  const res = await fetch(`${LANGFUSE}/api/public/traces/${traceId}`, { headers: { authorization: AUTH } });
  return res.ok ? ((await res.json()) as Trace) : null;
}

/**
 * What a fully ingested run trace looks like, from Langfuse's public API: the trace record carries
 * the run's `userId` and `sessionId` (trace attributes are written by the worker separately from the
 * observations), the segment root and the `run.result` event are there, there are at least
 * `generations` gateway generations each with its usage, and every observation that has a duration
 * has ended. Returns what is still missing, or [] when complete.
 */
function missingFrom(t: Trace | null, generations: number): string[] {
  if (!t) return ['the trace'];
  const missing: string[] = [];
  if (!t.userId) missing.push('trace.userId');
  if (!t.sessionId) missing.push('trace.sessionId');
  if (!t.observations.some((o) => o.type === 'AGENT')) missing.push('the AGENT segment root');
  if (!t.observations.some((o) => o.name === 'run.result')) missing.push('the run.result event');
  const gens = t.observations.filter((o) => o.type === 'GENERATION');
  if (gens.length < generations) missing.push(`${generations - gens.length} generation(s)`);
  if (gens.some((g) => !g.usage?.total)) missing.push('generation usage');
  // The join keys, too: each llm.* span's `litellm_call_id` and each generation's `litellm.call_id`. The public API
  // can return an ended observation before every attribute of it is visible (CI 22-23 Nov 2026: a generation whose
  // call id named no llm span, then green on re-run). Waiting for the keys to be there is readiness; whether they
  // MATCH is still asserted after.
  const noKey = joinKeysMissing(t.observations);
  if (noKey) missing.push(noKey);
  const open = t.observations.filter((o) => o.type !== 'EVENT' && !o.endTime).length;
  if (open > 0) missing.push(`${open} unfinished observation(s)`);
  return missing;
}

/**
 * Poll `GET /api/public/traces/<id>` until the trace is complete ({@link missingFrom}), within a
 * deadline. Langfuse ingests asynchronously (web → queue → worker → ClickHouse), so the public
 * API is read until it shows the whole trace; nothing is asserted before that.
 */
async function settledTrace(traceId: string, generations: number, timeoutMs = 120_000): Promise<Trace> {
  const deadline = Date.now() + timeoutMs;
  let missing: string[] = ['the trace'];
  while (Date.now() < deadline) {
    const t = await readTrace(traceId);
    missing = missingFrom(t, generations);
    if (missing.length === 0) return t!;
    await new Promise((r) => setTimeout(r, 500)); // poll cadence, not a wait-before-assert
  }
  assert.fail(`trace ${traceId} still incomplete after ${timeoutMs} ms: missing ${missing.join(', ')}`);
}

/** The WP-31 contract, read from Langfuse's own API. Throws on the first broken rule. */
function assertOneWriterTrace(t: Trace, modelCalls: number): void {
  const gens = t.observations.filter((o) => o.type === 'GENERATION');
  assert.equal(gens.length, modelCalls, `one generation per model call: ${modelCalls} calls, ${gens.length} generations`);
  for (const g of gens) assert.match(JSON.stringify(g.metadata ?? {}), /litellm/i, `generation ${g.id} is not the gateway's`);
  const llmSpans = new Map(t.observations.filter((o) => o.name.startsWith('llm.')).map((o) => [o.id, o]));
  assert.equal(llmSpans.size, modelCalls, 'one llm.<node> span per model call');
  // LiteLLM 1.109.1, `langfuse_otel` (components/litellm/UPSTREAM.md "Span scope"). Either way the
  // generation is in the run's trace and carries the call id the llm.<node> span minted:
  //   llm_only (the chart's) — the generation is a ROOT observation of the trace, joined to its
  //            llm.<node> span by litellm.call_id == litellm_call_id;
  //   full     — it nests under the gateway's request span, under the llm.<node> span.
  const byId = new Map(t.observations.map((o) => [o.id, o]));
  const llmByCall = new Map([...llmSpans.values()].map((o) => [String((o.metadata as { litellm_call_id?: string } | undefined)?.litellm_call_id ?? ''), o]));
  for (const g of gens) {
    const reported = String(((g.metadata as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {})['litellm.call_id'] ?? '');
    const llm = llmByCall.get(reported);
    assert.ok(reported && llm, `generation ${g.id}: litellm.call_id ${reported} names no llm.<node> span's litellm_call_id`);
    if (SCOPE === 'llm_only') {
      assert.equal(g.parentObservationId, null, `llm_only: generation ${g.id} is a root observation of the run's trace`);
    } else {
      const request = g.parentObservationId ? byId.get(g.parentObservationId) : undefined;
      assert.ok(request && request.name.startsWith('POST /v1/chat/completions'), `generation ${g.id} is not under the gateway's request span`);
      assert.equal(request.parentObservationId, llm!.id, `generation ${g.id} is not nested under its llm.<node> span`);
    }
  }
  const total = gens.reduce((n, g) => n + (g.usage?.total ?? 0), 0);
  assert.equal(total, 15 * modelCalls, 'the summed usage equals what the model reported — no doubling');
}

test(`TRACING E2E (Langfuse 3.194.1 + LiteLLM 1.109.1 langfuse_otel, scope ${SCOPE}): one trace per run, one generation per call, linked to its llm span, user and session set`, { skip: !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up' }, async () => {
  const stub = await startStubModel();
  try {
    const runId = `run_${randomUUID()}`;
    const result = await tracedRun(runId);
    assert.equal(result.reachedEnd, true, 'the run completed through the real gateway');
    const calls = stub.calls();
    assert.ok(calls >= 3, `the run made its model calls (${calls})`);

    const traceId = await langfuseTraceId(runId);
    const t = await settledTrace(traceId, calls);

    assertOneWriterTrace(t, calls);

    // Every observation hangs on the run's tree: its parent is another observation of the trace,
    // or the run's fixed root id (the segment root).
    const ids = new Set(t.observations.map((o) => o.id));
    const rootSpanId = (await langfuseTraceId(`root:${runId}`)).slice(0, 16);
    for (const o of t.observations) {
      assert.equal(o.traceId, traceId);
      // Under llm_only the gateway's generation is a trace root by design (joined by call id above).
      if (SCOPE === 'llm_only' && o.type === 'GENERATION') continue;
      assert.ok(o.parentObservationId === rootSpanId || (o.parentObservationId && ids.has(o.parentObservationId)), `${o.type} ${o.name} is not nested under the run`);
    }
    const segment = t.observations.filter((o) => o.parentObservationId === rootSpanId);
    assert.equal(segment.length, 1, 'exactly one segment root');
    assert.equal(segment[0].type, 'AGENT');
    assert.ok(t.observations.some((o) => o.type === 'CHAIN' && o.name.startsWith('plan_')), 'graph nodes are chain observations');
    assert.ok(t.observations.some((o) => o.type === 'TOOL'), 'the tool call is a tool observation');

    // Per-agent tokens and cost (run diagnostics): LiteLLM OTel v2 puts no caller metadata on the
    // generation, so diagnostics read the whole trace and attribute each generation to the agent on
    // its llm.<node> ancestor (run-diagnostics.ts `attributeNode`). Exactly the route's read.
    const metrics = shapeTraceMetrics(t.observations as never, ['reader']);
    assert.equal(metrics.perNode.reader?.tokens, 15 * calls, 'perNode is filled per agent');
    // The diagnostics route's own read (paged public observations by trace id) gives the same answer.
    const routeRows = await readTraceObservations(traceId);
    assert.ok(routeRows && routeRows.length === t.observations.length, `readTraceObservations returned ${routeRows?.length} of ${t.observations.length} observations`);
    assert.equal(shapeTraceMetrics(routeRows as never, ['reader']).perNode.reader?.tokens, 15 * calls, 'the route read attributes the same tokens');
    assert.ok((metrics.perNode.reader?.costUsd ?? 0) > 0, 'and carries the gateway cost');
    assert.equal(t.userId, USER_ID, 'userId is the bare runner uid');
    assert.equal(t.sessionId, `system:${SYSTEM_ID}`, 'sessionId is the system session');
    assert.ok(t.tags.includes(`system:${SYSTEM_ID}`));
  } finally {
    stub.server.close();
  }
});

test('TRACING E2E — NEGATIVE TWIN: a second writer re-introduced produces two generations per call and the contract fails', { skip: !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up' }, async () => {
  const stub = await startStubModel();
  try {
    const runId = `run_${randomUUID()}`;
    await tracedRun(runId, { secondWriter: true });
    const calls = stub.calls();
    const t = await settledTrace(await langfuseTraceId(runId), 2 * calls);
    assert.equal(t.observations.filter((o) => o.type === 'GENERATION').length, 2 * calls, 'the second writer doubled the generations');
    assert.throws(() => assertOneWriterTrace(t, calls), /one generation per model call/, 'the WP-31 contract must turn red with two writers');
  } finally {
    stub.server.close();
  }
});
