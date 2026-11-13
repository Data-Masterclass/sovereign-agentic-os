/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    One Langfuse trace per run — recorded-ingestion tests (checklist A19, A21, A24)
 * USER STORY: As the engine-rebuild engineer I want proof, without a cluster, that a run produces
 *             exactly ONE `trace-create` whose id is the run id, that every node span, model
 *             generation and tool span shares that id, that a RESUME continues the same trace, and
 *             that no model text leaks into the trace.
 * ARCHITECTURE: the REAL `langfuse` SDK with a recording `fetch` (a subclass), driven by the real
 *             engine over a memory checkpointer and the scripted model; nothing leaves the process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Langfuse } from 'langfuse';
import type { LangfuseFetchOptions, LangfuseFetchResponse } from 'langfuse-core';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { LlmCall } from '@core/runtime/agentic';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import {
  FIXTURE_TASK,
  SHAPE_SINGLE_READ_YAML,
  SHAPE_SUPERVISOR_YAML,
  graphDeps,
  scriptedLlm,
  type HoldSink,
} from '@tabs/agents/lib/engine/parity-harness';
import { argShape, boundedResult, langfuseRunObserver, redactCompletion, redactRequest, runTraceTags } from '@tabs/agents/lib/engine/observe';

type IngestionEvent = { id: string; type: string; body: Record<string, unknown> };

/** The SDK with its transport replaced: every ingestion batch is kept, nothing is sent. */
class RecordingLangfuse extends Langfuse {
  events: IngestionEvent[] = [];
  constructor() {
    super({ publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: 'http://langfuse.test', flushAt: 1000, flushInterval: 60_000 });
  }
  override async fetch(_url: string, options: LangfuseFetchOptions): Promise<LangfuseFetchResponse> {
    const body = JSON.parse(String(options.body ?? '{}')) as { batch?: IngestionEvent[] };
    this.events.push(...(body.batch ?? []));
    const ok = { successes: (body.batch ?? []).map((e) => ({ id: e.id, status: 201 })), errors: [] };
    return { status: 207, text: async () => JSON.stringify(ok), json: async () => ok, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  ofType(type: string): IngestionEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** The scripted model, reporting usage so generations carry tokens. */
function scriptedWithUsage(task: string): LlmCall {
  const inner = scriptedLlm(task);
  return async (req) => ({ ...(await inner(req)), usage: { input: 10, output: 5, total: 15 } });
}

const RUN_ID = 'run_0bserve-0000-4000-8000-000000000001';

async function runObserved(yaml: string, runId: string, client: RecordingLangfuse, opts: { resume?: boolean; signal?: AbortSignal; checkpointer?: ReturnType<typeof memoryCheckpointer>; onNodeComplete?: () => void } = {}) {
  const sys = parseSystem(yaml);
  const ir = compile(sys);
  const sink: HoldSink = { enqueued: [] };
  const llm = scriptedWithUsage(FIXTURE_TASK);
  const observe = langfuseRunObserver({ runId, systemId: 'sys-observe', systemName: sys.system.name, userId: 'rae', domain: sys.system.domain, engine: 'langgraph', task: FIXTURE_TASK, resume: opts.resume, client });
  const result = await runGraphEngine({
    ir,
    deps: { ...graphDeps(sys, 'sys-observe', llm, sink), observe },
    messages: [{ role: 'user', content: FIXTURE_TASK }],
    runId,
    resume: opts.resume,
    signal: opts.signal,
    checkpointer: opts.checkpointer ?? memoryCheckpointer(),
    hooks: { onNodeComplete: opts.onNodeComplete },
  });
  await observe.flush();
  return result;
}

test('TRACE-PER-RUN (A19/A21): exactly one trace-create with id = runId; nodes are spans, model calls generations, tool calls spans with the decision — all sharing the id', async () => {
  const client = new RecordingLangfuse();
  const result = await runObserved(SHAPE_SINGLE_READ_YAML, RUN_ID, client);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.traceId, RUN_ID);
  assert.equal(result.observed, true);

  const traces = client.ofType('trace-create');
  assert.equal(traces.length, 1, `expected exactly one trace-create, saw ${traces.length}`);
  const trace = traces[0].body;
  assert.equal(trace.id, RUN_ID);
  assert.equal(trace.userId, 'rae');
  assert.equal(trace.sessionId, 'sys-observe');
  const tags = trace.tags as string[];
  for (const t of runTraceTags({ domain: 'sales', systemId: 'sys-observe', runId: RUN_ID, engine: 'langgraph' })) assert.ok(tags.includes(t), `missing tag ${t}`);

  // Every observation hangs on the run trace.
  const observations = client.events.filter((e) => e.type !== 'trace-create');
  assert.ok(observations.length > 0);
  for (const o of observations) assert.equal(o.body.traceId, RUN_ID, `${o.type} ${String(o.body.name)} is not on the run trace`);

  // Node spans: plan/act/tools/route for the single agent, directly under the trace.
  const spanNames = client.ofType('span-create').map((s) => String(s.body.name));
  for (const prefix of ['plan_', 'act_', 'tools_', 'route_']) assert.ok(spanNames.some((n) => n.startsWith(prefix)), `no ${prefix} span`);
  const nodeSpans = client.ofType('span-create').filter((s) => /^(plan|act|tools|route)_/.test(String(s.body.name)));
  for (const s of nodeSpans) assert.equal(s.body.parentObservationId ?? undefined, undefined, `${s.body.name} must be a direct child of the trace`);

  // Model calls: one generation per call (plan + two acts), with usage on the update, nested under a node span.
  const gens = client.ofType('generation-create');
  assert.ok(gens.length >= 3, `expected ≥3 generations, saw ${gens.length}`);
  const nodeSpanIds = new Set(nodeSpans.map((s) => String(s.body.id)));
  for (const g of gens) assert.ok(nodeSpanIds.has(String(g.body.parentObservationId)), 'a generation must nest under a node span');
  const genUpdates = client.ofType('generation-update');
  assert.ok(genUpdates.some((u) => (u.body.usage as { total?: number } | undefined)?.total === 15), 'usage from the completion must land on the generation');

  // Tool calls: a span named tool.<name> carrying the decision.
  const toolSpans = client.ofType('span-create').filter((s) => String(s.body.name).startsWith('tool.'));
  assert.equal(toolSpans.length, 1);
  const toolEnd = client.ofType('span-update').find((u) => u.body.id === toolSpans[0].body.id);
  assert.equal((toolEnd?.body.metadata as { decision?: string }).decision, 'ok');
  assert.ok(spanNames.includes('run.result'), 'the run ends with a result span');
});

test('TRACE-PER-RUN: redaction — model text never enters the trace, the tool-call structure does', async () => {
  const client = new RecordingLangfuse();
  await runObserved(SHAPE_SINGLE_READ_YAML, 'run_0bserve-0000-4000-8000-000000000002', client);
  for (const g of client.ofType('generation-create')) {
    const input = g.body.input as { messages: Array<{ role: string; chars: number; content?: unknown }> };
    assert.ok(input.messages.length > 0);
    for (const m of input.messages) {
      assert.equal(typeof m.chars, 'number');
      assert.equal(m.content, undefined, 'message text leaked into the trace');
    }
    // Message TEXT never appears; the tool-call STRUCTURE (names, ids, args) is kept on purpose.
    const textOnly = input.messages.map((m) => ({ ...m, tool_calls: undefined }));
    assert.ok(!JSON.stringify(textOnly).includes(FIXTURE_TASK), 'the user task text leaked into a generation');
    const out = g.body.output as { chars?: number; content?: unknown } | undefined;
    if (out) assert.equal(out.content, undefined);
  }
  const red = redactRequest({ model: 'm', messages: [{ role: 'user', content: 'secret text' }], tools: [{ type: 'function', function: { name: 'query_data', description: '', parameters: {} } }] });
  assert.deepEqual(red.messages, [{ role: 'user', chars: 11 }]);
  assert.deepEqual(red.tools, ['query_data']);
  assert.equal(red.redaction, 'structure', 'the level the trace was written at is recorded with it');
});

test('A4 review: `strict` redaction keeps argument KEY NAMES and sizes only, and drops the result preview', () => {
  // `structure` (the default) keeps the whole argument object and a 160-char result preview.
  const loose = redactRequest(
    { model: 'm', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_data', arguments: '{"sql":"select * from patients where ssn = 123"}' } }] }] },
    'structure',
  );
  assert.match(JSON.stringify(loose), /patients/, 'structure keeps the arguments — that is the point of it');
  assert.deepEqual(boundedResult('a b  c', 'structure'), { chars: 6, preview: 'a b c' });

  // `strict` keeps the SHAPE of the call and nothing of its content.
  const strict = redactRequest(
    { model: 'm', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_data', arguments: '{"sql":"select * from patients where ssn = 123"}' } }] }] },
    'strict',
  );
  const json = JSON.stringify(strict);
  assert.ok(!json.includes('patients'), 'strict must not carry argument VALUES');
  assert.match(json, /"sql"/, 'the argument key names are kept — a trace must still be readable');
  assert.match(json, /"chars"/);
  assert.deepEqual(boundedResult('a b  c', 'strict'), { chars: 6 }, 'no preview under strict');
  assert.deepEqual(argShape({ sql: 'abc', k: 12 }), { sql: { chars: 3 }, k: { chars: 2 } });

  const comp = redactCompletion({ content: 'hello', toolCalls: [{ id: 'c1', name: 'query_data', args: { sql: 'secret-sql' } }] }, 'strict');
  assert.ok(!JSON.stringify(comp).includes('secret-sql'));
  assert.equal(comp.chars, 5);
});

test('TRACE-PER-RUN (resume): a resumed thread continues the SAME trace id and creates no second trace', async () => {
  const checkpointer = memoryCheckpointer();
  const runId = 'run_0bserve-0000-4000-8000-000000000003';
  const first = new RecordingLangfuse();
  const abort = new AbortController();
  const aborted = await runObserved(SHAPE_SUPERVISOR_YAML, runId, first, { checkpointer, signal: abort.signal, onNodeComplete: () => abort.abort() });
  assert.equal(aborted.interrupted, true);
  assert.equal(first.ofType('trace-create').length, 1);

  const second = new RecordingLangfuse();
  const resumed = await runObserved(SHAPE_SUPERVISOR_YAML, runId, second, { checkpointer, resume: true });
  assert.equal(resumed.reachedEnd, true);
  assert.equal(second.ofType('trace-create').length, 0, 'a resume must not create a second trace');
  assert.ok(second.events.length > 0, 'the resume recorded observations');
  for (const o of second.events) assert.equal(o.body.traceId, runId);
  assert.ok(second.ofType('span-create').some((s) => s.body.name === 'run.result'));
});

test('TRACE-PER-RUN: no Langfuse configured → the no-op observer; the run is unchanged and unobserved', async () => {
  const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
  const observe = langfuseRunObserver({ runId: 'run_0bserve-0000-4000-8000-000000000004', systemId: 's', systemName: sys.system.name, userId: 'rae', domain: 'sales', client: null });
  assert.equal(observe.enabled, false);
  const span = observe.span('plan_x');
  const llm = span.llm(async () => ({ content: 'ok', toolCalls: [] }));
  assert.equal((await llm({ model: 'm', messages: [] })).content, 'ok');
  span.end();
  await observe.flush();
});
