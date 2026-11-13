/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    X9 — an agent uses the data as context ROBUSTLY (`agent-reads-gold-dataset`)
 * USER STORY: As an engineer whose agent is granted `query_data` on a gold dataset I want proof
 *             that the Trino call runs as ME and not a service principal, that a 50 000-row answer
 *             is truncated BEFORE it enters the prompt with the real row count visible, that a
 *             timeout or an upstream failure comes back as a typed `tool-step` error the graph can
 *             route on rather than a hung superstep, and that the call is in the run's Langfuse
 *             trace with the dataset id and the run's tags.
 * ARCHITECTURE:
 *   - The engine shape `SHAPE_GOLD_DATA_YAML` driven through the REAL `buildGraph` /
 *     `grantedToolSpecs` / `grantedToolExecutor` over a memory checkpointer; only the model and
 *     the MCP dispatch are faked (`fixtureToolDeps` handlers), as everywhere in this harness.
 *   - The Langfuse half uses the real SDK with a recording transport (the pattern of
 *     `observe.test.ts`), so nothing leaves the process.
 *   - The deadline/bound live in `engine/tool-result.ts` and apply to EVERY tool; making the real
 *     `query_data` handler itself bound and deadline its Trino read is a follow-up in `tabs/data`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Langfuse } from 'langfuse';
import type { LangfuseFetchOptions, LangfuseFetchResponse } from 'langfuse-core';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { AgenticStep, LlmRequest } from '@core/runtime/agentic';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { langfuseRunObserver } from '@tabs/agents/lib/engine/observe';
import {
  FIXTURE_TASK,
  FIXTURE_USER,
  GOLD_DATASET_FQN,
  GOLD_DATASET_ID,
  SHAPE_GOLD_DATA_YAML,
  graphDeps,
  toolCallingLlm,
  type FixtureDispatch,
  type HoldSink,
} from '@tabs/agents/lib/engine/parity-harness';
import {
  boundToolResult,
  callToolGuarded,
  toolErrorCode,
  typedToolError,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from '@tabs/agents/lib/engine/tool-result';

const SYSTEM_ID = 'sys-x9-gold';
const QUERY = `select order_id, customer_id, amount from ${GOLD_DATASET_FQN}`;

/** The SDK with its transport replaced: every ingestion batch is kept, nothing is sent. */
class RecordingLangfuse extends Langfuse {
  events: { id: string; type: string; body: Record<string, unknown> }[] = [];
  constructor() {
    super({ publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: 'http://langfuse.test', flushAt: 1000, flushInterval: 60_000 });
  }
  override async fetch(_url: string, options: LangfuseFetchOptions): Promise<LangfuseFetchResponse> {
    const body = JSON.parse(String(options.body ?? '{}')) as { batch?: { id: string; type: string; body: Record<string, unknown> }[] };
    this.events.push(...(body.batch ?? []));
    const ok = { successes: (body.batch ?? []).map((e) => ({ id: e.id, status: 201 })), errors: [] };
    return { status: 207, text: async () => JSON.stringify(ok), json: async () => ok, arrayBuffer: async () => new ArrayBuffer(0) };
  }
}

type RunOut = {
  steps: { node: string; step: AgenticStep }[];
  dispatches: FixtureDispatch[];
  requests: LlmRequest[];
  path: string[];
  finalText: string;
  reachedEnd: boolean;
};

/** Drive the X9 shape with the given scripted calls and fake data handlers. */
async function runShape(opts: {
  calls: { name: string; args: Record<string, unknown> }[];
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
  maxChars?: number;
  timeoutMs?: number;
  runId?: string;
  client?: RecordingLangfuse;
}): Promise<RunOut> {
  const sys = parseSystem(SHAPE_GOLD_DATA_YAML);
  const ir = compile(sys);
  const sink: HoldSink = { enqueued: [] };
  const dispatches: FixtureDispatch[] = [];
  const requests: LlmRequest[] = [];
  const scripted = toolCallingLlm(opts.calls);
  const runId = opts.runId ?? 'run_x9-0000-4000-8000-000000000001';
  const deps = graphDeps(sys, SYSTEM_ID, async (req) => {
    requests.push(req);
    return scripted(req);
  }, sink, {
    handlers: opts.handlers,
    dispatches,
    ...(opts.maxChars !== undefined ? { toolResultMaxChars: opts.maxChars } : {}),
    ...(opts.timeoutMs !== undefined ? { toolCallTimeoutMs: opts.timeoutMs } : {}),
  });
  const steps: { node: string; step: AgenticStep }[] = [];
  const observe = opts.client
    ? langfuseRunObserver({
        runId,
        systemId: SYSTEM_ID,
        systemName: sys.system.name,
        userId: FIXTURE_USER.id,
        domain: sys.system.domain,
        engine: 'langgraph',
        task: FIXTURE_TASK,
        client: opts.client,
      })
    : undefined;
  const result = await runGraphEngine({
    ir,
    deps: { ...deps, ...(observe ? { observe } : {}) },
    messages: [{ role: 'user', content: FIXTURE_TASK }],
    runId,
    checkpointer: memoryCheckpointer(),
    hooks: { onStep: (ev) => steps.push({ node: ev.node, step: ev.step }) },
  });
  if (observe) await observe.flush();
  return { steps, dispatches, requests, path: result.path, finalText: result.finalText, reachedEnd: result.reachedEnd };
}

/** 50 000 rows of a plausible gold mart, as `query_data` returns them. */
function bigResult(rows = 50_000): string {
  return JSON.stringify({
    principal: 'user:amir',
    authorized: true,
    policy: 'data.query.allow',
    columns: ['order_id', 'customer_id', 'amount'],
    rows: Array.from({ length: rows }, (_, i) => ({ order_id: `o-${i}`, customer_id: `c-${i % 997}`, amount: (i % 91) + 0.5 })),
  });
}

// ------------------------------------------------------------------ (a) --

test('X9 (a): the governed data read dispatches AS THE RUNNER, with the dataset the grant names', async () => {
  const out = await runShape({
    calls: [
      { name: 'query_data', args: { sql: QUERY } },
      { name: 'get_dataset', args: { datasetId: GOLD_DATASET_ID } },
    ],
    handlers: {
      query_data: () => ({ columns: ['order_id'], rows: [{ order_id: 'o-1' }] }),
      get_dataset: () => ({ id: GOLD_DATASET_ID, tier: 'product', fqn: GOLD_DATASET_FQN }),
    },
  });
  assert.deepEqual(out.dispatches.map((d) => d.tool), ['query_data', 'get_dataset']);
  for (const d of out.dispatches) {
    // The acting user, not a service principal: the executor passes the RUNNER to `handleRpc`,
    // which is what makes OPA / row-level security see the human.
    assert.equal(d.user.id, FIXTURE_USER.id);
    assert.equal(d.user.role, FIXTURE_USER.role);
    assert.equal(/^os-/.test(d.user.id), false, 'never the `os-<systemId>` system principal');
  }
  assert.equal(out.dispatches[0].args.sql, QUERY, 'the SQL names the granted gold table');
  assert.ok(String(out.dispatches[0].args.sql).includes(GOLD_DATASET_FQN));
  assert.equal(out.dispatches[1].args.datasetId, GOLD_DATASET_ID, 'the dataset id reaches the governed tool');
  assert.equal(out.reachedEnd, true);
});

test('X9 (a2): a tool the system does not grant never reaches the dispatch at all', async () => {
  const out = await runShape({
    calls: [{ name: 'delete_rows', args: { datasetId: GOLD_DATASET_ID } }],
    handlers: { delete_rows: () => ({ deleted: 'everything' }) },
  });
  assert.deepEqual(out.dispatches, [], 'the grant gate refused it before any side effect');
  assert.equal(out.steps[0].step.isError, true);
  assert.match(out.steps[0].step.result, /not available/i);
});

// ------------------------------------------------------------------ (b) --

test('X9 (b): a 50 000-row result is truncated BEFORE the prompt, with a visible marker and the row count', async () => {
  const maxChars = 4_000;
  const out = await runShape({
    calls: [{ name: 'query_data', args: { sql: QUERY } }],
    handlers: { query_data: () => bigResult() },
    maxChars,
  });
  const step = out.steps.find((s) => s.step.tool === 'query_data')!.step;
  assert.ok(step.result.length <= maxChars + 64, `the recorded result is bounded (${step.result.length})`);
  assert.match(step.result, /\[truncated: showing \d+ of 50000 rows\]/);

  // What the MODEL saw: the tool message of the request AFTER the call.
  const toolMessages = out.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool'));
  assert.ok(toolMessages.length >= 1, 'the model was fed the tool result');
  const fed = toolMessages.at(-1)!.content;
  assert.ok(fed.length <= maxChars + 64, `the prompt never saw the full payload (${fed.length})`);
  assert.match(fed, /\[truncated: showing \d+ of 50000 rows\]/);
  // Still well-formed JSON before the marker, so the model can read the sample it did get.
  const body = JSON.parse(fed.slice(0, fed.lastIndexOf('\n'))) as { rows: unknown[]; columns: string[] };
  assert.ok(body.rows.length > 0 && body.rows.length < 50_000);
  assert.deepEqual(body.columns, ['order_id', 'customer_id', 'amount'], 'the envelope survives truncation');
});

test('X9 (b2): a result that already fits is passed through byte-for-byte', async () => {
  const payload = JSON.stringify({ columns: ['order_id'], rows: [{ order_id: 'o-1' }] });
  const out = await runShape({
    calls: [{ name: 'query_data', args: { sql: QUERY } }],
    handlers: { query_data: () => payload },
  });
  assert.equal(out.steps.find((s) => s.step.tool === 'query_data')!.step.result, payload);
});

test('X9 (b3): `boundToolResult` — rows when it can, characters when it cannot, always a marker', () => {
  const small = JSON.stringify({ rows: [1, 2, 3] });
  assert.deepEqual(boundToolResult(small, 1_000), { text: small, truncated: false, chars: { kept: small.length, total: small.length } });

  const rows = boundToolResult(bigResult(1_000), 2_000);
  assert.equal(rows.truncated, true);
  assert.equal(rows.rows!.total, 1_000);
  assert.ok(rows.rows!.kept > 0 && rows.rows!.kept < 1_000);
  assert.ok(rows.text.length <= 2_000 + 64);
  assert.match(rows.text, new RegExp(`\\[truncated: showing ${rows.rows!.kept} of 1000 rows\\]`));

  // Not row-shaped: a character cut, with the character counts named.
  const prose = 'x'.repeat(5_000);
  const cut = boundToolResult(prose, 1_000);
  assert.equal(cut.truncated, true);
  assert.equal(cut.rows, undefined);
  assert.match(cut.text, /\[truncated: showing \d+ of 5000 characters\]/);

  // A bare array works too, and so does an empty-row envelope (nothing to drop ⇒ character cut).
  const bare = boundToolResult(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ i }))), 400);
  assert.equal(bare.rows!.total, 500);
  assert.equal(boundToolResult(JSON.stringify({ rows: [], note: 'y'.repeat(3_000) }), 500).rows, undefined);
  // The default is a real bound, not Infinity.
  assert.equal(boundToolResult('z'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 10)).truncated, true);
});

// ------------------------------------------------------------------ (c) --

test('X9 (c): a tool that never answers becomes a typed `timeout` tool-step, and the run continues', async () => {
  const out = await runShape({
    calls: [{ name: 'query_data', args: { sql: QUERY } }],
    handlers: { query_data: () => new Promise(() => { /* never settles — a hung Trino read */ }) },
    timeoutMs: 25,
  });
  const step = out.steps.find((s) => s.step.tool === 'query_data')!.step;
  assert.equal(step.isError, true);
  assert.equal(toolErrorCode(step.result), 'timeout');
  assert.match(step.result, /did not answer within 25 ms/);
  assert.equal(out.reachedEnd, true, 'the superstep ended — the run was never hung');
  assert.deepEqual(out.path, ['analyst']);
});

test('X9 (c2): an upstream failure becomes a typed `upstream_error`, not a crashed graph', async () => {
  const out = await runShape({
    calls: [{ name: 'query_data', args: { sql: QUERY } }],
    handlers: {
      query_data: () => {
        throw new Error('TrinoUserError: Table iceberg.sales.gold_orders not found');
      },
    },
  });
  const step = out.steps.find((s) => s.step.tool === 'query_data')!.step;
  assert.equal(step.isError, true);
  assert.equal(toolErrorCode(step.result), 'upstream_error');
  assert.match(step.result, /Table iceberg\.sales\.gold_orders not found/);
  assert.equal(out.reachedEnd, true);
});

test('X9 (c3): the deadline is a typed result; a THROWN dispatch still fails the superstep', async () => {
  const slow = await callToolGuarded(() => new Promise(() => {}), { name: 't', args: {} }, { timeoutMs: 5 });
  assert.deepEqual([slow.isError, toolErrorCode(slow.text)], [true, 'timeout']);
  // A throw is NOT swallowed: the governed executor already returns a tool's own failure as a
  // typed result, so an exception means the dispatch itself broke — the superstep must fail so the
  // checkpoint keeps the exactly-once property of the calls that already ran (A2's M5).
  await assert.rejects(() => callToolGuarded(async () => { throw new Error('dispatch broke'); }, { name: 't', args: {} }), /dispatch broke/);
  // A tool's OWN typed error is passed through unchanged (the engine does not relabel policy).
  const own = typedToolError('upstream_error', 'x');
  assert.equal((await callToolGuarded(async () => own, { name: 't', args: {} })).text, own.text);
  // A timer is always cleared, so a passing call cannot hold the event loop open.
  const fine = await callToolGuarded(async () => ({ text: 'ok', isError: false }), { name: 't', args: {} }, { timeoutMs: 50 });
  assert.deepEqual(fine, { text: 'ok', isError: false });
});

// ------------------------------------------------------------------ (d) --

test('X9 (d): the data read is a span of the run trace, carrying the dataset and the run tags', async () => {
  const client = new RecordingLangfuse();
  const runId = 'run_x9-0000-4000-8000-00000000000d';
  await runShape({
    calls: [
      { name: 'query_data', args: { sql: QUERY } },
      { name: 'get_dataset', args: { datasetId: GOLD_DATASET_ID } },
    ],
    handlers: {
      query_data: () => bigResult(100),
      get_dataset: () => ({ id: GOLD_DATASET_ID, fqn: GOLD_DATASET_FQN }),
    },
    runId,
    client,
  });
  const traces = client.events.filter((e) => e.type === 'trace-create');
  assert.equal(traces.length, 1, 'one trace per run');
  assert.equal(traces[0].body.id, runId);
  assert.deepEqual(traces[0].body.tags, [`domain:sales`, `agent:${SYSTEM_ID}`, `run:${runId}`, 'engine:langgraph']);

  const spans = client.events.filter((e) => e.type === 'span-create');
  const toolSpans = spans.filter((e) => String(e.body.name ?? '').startsWith('tool.'));
  assert.deepEqual(toolSpans.map((e) => e.body.name), ['tool.query_data', 'tool.get_dataset']);
  for (const s of toolSpans) assert.equal(s.body.traceId, runId, 'every tool span is under the run trace');

  // The dataset is identifiable from the span input — the SQL for the query, the id for the read.
  const inputs = toolSpans.map((e) => JSON.stringify(e.body.input));
  assert.ok(inputs[0].includes(GOLD_DATASET_FQN), 'the queried gold table is in the span');
  assert.ok(inputs[1].includes(GOLD_DATASET_ID), 'the dataset id is in the span');

  // The RESULT is bounded in the trace too (a 160-char preview + the size), so a large read
  // cannot flood Langfuse any more than it can flood the prompt.
  const updates = client.events.filter((e) => e.type === 'span-update');
  const output = updates.map((e) => e.body.output).find((o) => o && typeof (o as { chars?: number }).chars === 'number') as { chars: number; preview?: string };
  assert.ok(output.chars > 0);
  assert.ok((output.preview ?? '').length <= 161);
});
