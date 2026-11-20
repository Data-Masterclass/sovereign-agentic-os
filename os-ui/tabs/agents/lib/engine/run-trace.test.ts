/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The one Langfuse writer — the exported OTel spans of a real engine run (WP-31)
 * USER STORY: As the tracing engineer I want proof, without a cluster, that a run is ONE trace with
 *             id `createTraceId(runId)`, that every segment hangs on the run's fixed root id, that
 *             nodes, model calls and tool calls nest, that the app never exports a GENERATION, and
 *             that the runner's uid and `system:<id>` ride on every span.
 * ARCHITECTURE: the REAL `NodeSDK` + `LangfuseSpanProcessor` with an in-memory exporter (the
 *             processor's documented `exporter` option), driven by the real engine over a memory
 *             checkpointer and the scripted model. The real-server proof is `tracing.e2e.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { FIXTURE_TASK, SHAPE_SINGLE_READ_YAML, SHAPE_SUPERVISOR_YAML, graphDeps, scriptedLlm, type HoldSink } from '@tabs/agents/lib/engine/parity-harness';
import { argShape, boundedResult, redactCompletion, redactRequest } from '@core/infra/trace-port';
import { __useSpanExporterForTests, exportOsSpan, flushLangfuse, langfuseTraceId, osMask, recordObservation, withRunTrace } from '@core/infra/langfuse';

const exporter = new InMemorySpanExporter();
__useSpanExporterForTests(exporter);

const TYPE = 'langfuse.observation.type';
const typeOf = (s: ReadableSpan) => s.attributes[TYPE];
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

/** The scripted model, recording each request the gateway would receive. */
function recordingLlm(task: string, seen: LlmRequest[]): LlmCall {
  const inner = scriptedLlm(task);
  return async (req) => {
    seen.push(req);
    return { ...(await inner(req)), usage: { input: 10, output: 5, total: 15 } };
  };
}

async function runTraced(yaml: string, runId: string, opts: { resume?: boolean; signal?: AbortSignal; checkpointer?: ReturnType<typeof memoryCheckpointer>; onNodeComplete?: () => void; seen?: LlmRequest[] } = {}) {
  const sys = parseSystem(yaml);
  const sink: HoldSink = { enqueued: [] };
  const llm = recordingLlm(FIXTURE_TASK, opts.seen ?? []);
  const result = await withRunTrace(
    { runId, systemId: 'sys-observe', systemName: sys.system.name, userId: 'rae', domain: sys.system.domain, task: FIXTURE_TASK, resume: opts.resume, environment: 'test', principal: 'os-sys-observe' },
    (observe) => runGraphEngine({
      ir: compile(sys),
      deps: { ...graphDeps(sys, 'sys-observe', llm, sink), observe },
      messages: [{ role: 'user', content: FIXTURE_TASK }],
      runId,
      resume: opts.resume,
      signal: opts.signal,
      checkpointer: opts.checkpointer ?? memoryCheckpointer(),
      hooks: { onNodeComplete: opts.onNodeComplete },
    }),
  );
  await flushLangfuse();
  return result;
}

const spansOf = (traceId: string) => exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);

test('ONE TRACE PER RUN: trace id = createTraceId(runId); nodes are chains, model calls llm.<node> spans, tool calls tools — all nested, no app generation', async () => {
  const runId = 'run_0bserve-0000-4000-8000-000000000101';
  const seen: LlmRequest[] = [];
  const result = await runTraced(SHAPE_SINGLE_READ_YAML, runId, { seen });
  const traceId = await langfuseTraceId(runId);
  assert.match(traceId, /^[0-9a-f]{32}$/);
  assert.equal(result.reachedEnd, true);
  assert.equal(result.traceId, traceId, 'the run result carries the Langfuse trace id');
  assert.equal(result.observed, true);

  const spans = spansOf(traceId);
  assert.ok(spans.length > 0);
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));

  // The segment root: one `agent` observation on the run's FIXED root span id.
  const roots = spans.filter((s) => typeOf(s) === 'agent');
  assert.equal(roots.length, 1);
  const rootSpanId = (await langfuseTraceId(`root:${runId}`)).slice(0, 16);
  assert.equal(parentOf(roots[0]), rootSpanId);
  assert.match(roots[0].name, /^run /);

  // Nodes: chains under the segment.
  const chains = spans.filter((s) => typeOf(s) === 'chain');
  for (const prefix of ['plan_', 'act_', 'tools_', 'route_']) assert.ok(chains.some((c) => c.name.startsWith(prefix)), `no ${prefix} node`);
  for (const c of chains) assert.equal(parentOf(c), roots[0].spanContext().spanId);

  // Model calls: exactly one llm.<node> span per call, under a node, and its id is what the gateway got.
  const llmSpans = spans.filter((s) => s.name.startsWith('llm.'));
  assert.equal(llmSpans.length, seen.length, 'one llm.<node> span per model call');
  for (const s of llmSpans) assert.equal(byId.get(parentOf(s)!)?.attributes[TYPE], 'chain', `${s.name} must nest under a node`);
  const llmIds = new Set(llmSpans.map((s) => s.spanContext().spanId));
  for (const r of seen) {
    assert.equal(r.observe?.traceId, traceId, 'the gateway is told the run trace id');
    assert.ok(llmIds.has(r.observe!.parentObservationId!), 'the gateway nests under the llm span that wrapped the call');
  }
  assert.equal(spans.filter((s) => typeOf(s) === 'generation').length, 0, 'the app writes no generation — the gateway owns it');
  for (const s of llmSpans) assert.equal(s.attributes['langfuse.observation.usage_details'], undefined, 'no usage on the app side: tokens are counted once');

  // Tool calls: a `tool` observation carrying the decision.
  const tools = spans.filter((s) => typeOf(s) === 'tool');
  assert.equal(tools.length, 1);
  assert.match(String(tools[0].attributes['langfuse.observation.metadata.decision'] ?? tools[0].attributes['langfuse.observation.metadata']), /ok/);

  // Identity on every span: the runner's bare uid and the system session.
  for (const s of spans) {
    assert.equal(s.attributes['user.id'], 'rae', `${s.name} lacks user.id`);
    assert.equal(s.attributes['session.id'], 'system:sys-observe', `${s.name} lacks session.id`);
  }
  assert.ok(spans.some((s) => s.name === 'run.result'));
});

test('REDACTION: model text never reaches an exported span; strict keeps key names and sizes only', async () => {
  const runId = 'run_0bserve-0000-4000-8000-000000000102';
  await runTraced(SHAPE_SINGLE_READ_YAML, runId);
  for (const s of spansOf(await langfuseTraceId(runId)).filter((x) => x.name.startsWith('llm.'))) {
    const input = JSON.parse(String(s.attributes['langfuse.observation.input'])) as { messages: Array<{ content?: unknown; chars: number; tool_calls?: unknown }> };
    for (const m of input.messages) {
      assert.equal(typeof m.chars, 'number');
      assert.equal(m.content, undefined, 'message text leaked into the trace');
    }
    const textOnly = input.messages.map((m) => ({ ...m, tool_calls: undefined }));
    assert.ok(!JSON.stringify(textOnly).includes(FIXTURE_TASK), 'the user task text leaked into a model-call span');
  }
  const strict = redactRequest({ model: 'm', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_data', arguments: '{"sql":"select * from patients"}' } }] }] }, 'strict');
  assert.ok(!JSON.stringify(strict).includes('patients'));
  assert.match(JSON.stringify(strict), /"sql"/);
  assert.deepEqual(boundedResult('a b  c', 'strict'), { chars: 6 });
  assert.deepEqual(boundedResult('a b  c', 'structure'), { chars: 6, preview: 'a b c' });
  assert.deepEqual(argShape({ sql: 'abc', k: 12 }), { sql: { chars: 3 }, k: { chars: 2 } });
  assert.ok(!JSON.stringify(redactCompletion({ content: 'hello', toolCalls: [{ id: 'c1', name: 'q', args: { sql: 'secret-sql' } }] }, 'strict')).includes('secret-sql'));
});

test('RESUME: the second segment is in the SAME trace and hangs on the same fixed root id', async () => {
  const runId = 'run_0bserve-0000-4000-8000-000000000103';
  const checkpointer = memoryCheckpointer();
  const abort = new AbortController();
  const first = await runTraced(SHAPE_SUPERVISOR_YAML, runId, { checkpointer, signal: abort.signal, onNodeComplete: () => abort.abort() });
  assert.equal(first.interrupted, true);
  const resumed = await runTraced(SHAPE_SUPERVISOR_YAML, runId, { checkpointer, resume: true });
  assert.equal(resumed.reachedEnd, true);
  const segments = spansOf(await langfuseTraceId(runId)).filter((s) => typeOf(s) === 'agent');
  assert.equal(segments.length, 2, 'one root observation per segment');
  assert.deepEqual(segments.map((s) => s.name.startsWith('run segment')).sort(), [false, true]);
  assert.equal(new Set(segments.map(parentOf)).size, 1, 'both segments share the fixed root id');
});

test('ONE WRITER: an app-side generation is never exported; inline media is masked; a standalone record nests in the active observation', async () => {
  // shouldExportSpan drops a generation however it was made.
  const fake = { attributes: { [TYPE]: 'generation' }, instrumentationScope: { name: 'langfuse-sdk' } } as unknown as ReadableSpan;
  assert.equal(exportOsSpan({ otelSpan: fake }), false);
  const toolSpan = { attributes: { [TYPE]: 'tool' }, instrumentationScope: { name: 'langfuse-sdk' } } as unknown as ReadableSpan;
  assert.equal(exportOsSpan({ otelSpan: toolSpan }), true);

  assert.equal(osMask({ data: 'see data:image/png;base64,AAAABBBB' }), 'see [media image/png 6 bytes sha256:' + (osMask({ data: 'data:image/png;base64,AAAABBBB' }) as string).split('sha256:')[1]);
  assert.ok(!(osMask({ data: '{"image_url":"data:image/png;base64,AAAABBBB"}' }) as string).includes('AAAABBBB'));

  // Inside a run's tool call, a governed record (a retrieval, a data tool) nests under that tool.
  const runId = 'run_0bserve-0000-4000-8000-000000000104';
  await withRunTrace({ runId, systemId: 's', systemName: 'S', userId: 'rae', domain: 'sales' }, async (observe) => {
    const node = observe.span('tools_x');
    await node.tool({ id: 'c1', name: 'retrieve', args: {} }, { decision: 'ok' }, async () => {
      assert.equal(recordObservation({ name: 'knowledge.context_pack', asType: 'retriever', input: { query: 'q' } }), true);
      return { text: 'ok', isError: false };
    });
    node.end();
    observe.finish({ reachedEnd: true, parked: false, interrupted: false, failed: false, path: [], finalChars: 0, stepsUsed: 0 });
  });
  await flushLangfuse();
  const spans = spansOf(await langfuseTraceId(runId));
  const tool = spans.find((s) => typeOf(s) === 'tool')!;
  const retriever = spans.find((s) => typeOf(s) === 'retriever');
  assert.ok(retriever, 'the retrieval was recorded in the run trace');
  assert.equal(parentOf(retriever!), tool.spanContext().spanId);

  // Outside any trace it is its own small trace, never a raw ingestion POST.
  exporter.reset();
  assert.equal(recordObservation({ name: 'data.query', asType: 'tool', input: { sql: 'select 1' }, tags: ['data-golden-path'] }), true);
  await flushLangfuse();
  const own = exporter.getFinishedSpans();
  assert.equal(own.length, 1);
  assert.equal(own[0].parentSpanContext, undefined);
  assert.deepEqual(own[0].attributes['langfuse.trace.tags'], ['data-golden-path']);
});
