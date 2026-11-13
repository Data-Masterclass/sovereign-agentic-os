/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 — a run through the QUEUE: parked by an approval, continued by a `resume` job
 * USER STORY: As the runner I file a run, it parks on a held write, a domain admin approves it in
 *             Governance, and the resume runs as a JOB — in the worker pod, or inline in the
 *             deciding process — and my panel, tailing `run_events` from seq 0, sees the whole
 *             story in order: node-started, approval-required, done{parked}, resumed, …, done. The
 *             held write still executes exactly once, as me.
 * ARCHITECTURE:
 *   - A2's P3 fixtures (the held-write system, the scripted model, the REAL grant gates with
 *     `holdAt:'node'`, a spy `handleRpc`) over a private `MemorySaver` — reused here so the queue
 *     is tested against a REAL graph run, not a mock of one.
 *   - The job store is the in-memory one and the events go through `runEventSink`, exactly as
 *     `build/run-jobs-server.ts` wires them; `tailRunEvents` is the route's tail.
 *   - No server-only module: this proves the QUEUE semantics, not the Next wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import type { LlmCall } from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { memoryApprovalPort, type MemoryApprovalPort, type RunOwner } from '@tabs/agents/lib/engine/approval-port';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { runGraphEngine, type EngineRunResult } from '@tabs/agents/lib/engine/run';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { memoryRunJobStore, runEventSink, tailRunEvents, type NewRunJob, type RunJobStore } from '@tabs/agents/lib/engine/jobs';

const SYSTEM_ID = 'sys-held';
const RUN_ID = 'queued-held-run';
const OWNER: RunOwner = { systemId: SYSTEM_ID, userId: FIXTURE_USER.id, domain: 'sales' };
const TASK = 'File the promotion of the Q3 findings.';

const HELD_YAML = `version: '1'
system: { name: held, domain: sales, visibility: Personal }
safety_preset: read-propose
entrypoint: writer
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, request_promotion], connections: [] }
agents:
  - { id: writer, role: writes, agent_md: '# writer', memory_md: '# Memory', tools: [search_knowledge, request_promotion] }
edges: []
`;

const BATCH = [
  { id: 'c-read', name: 'search_knowledge', args: { q: 'Q3 findings' } },
  { id: 'c-write', name: 'request_promotion', args: { id: 'kn_q3' } },
];

/** PLAN → fixed; first ACT → the batch; every later ACT → FINAL. */
function script(): LlmCall {
  let n = 0;
  return async (req) => {
    if (!req.tools) return { content: 'plan: do it', toolCalls: [] };
    n += 1;
    return n === 1 ? { content: '', toolCalls: BATCH } : { content: 'FINAL(writer)', toolCalls: [] };
  };
}

type Spy = OsToolDeps & { rpc: { user: CurrentUser; tool: string }[] };
function spyDeps(): Spy {
  const rpc: Spy['rpc'] = [];
  return {
    rpc,
    enqueue: (() => { throw new Error('the executor must not hold under holdAt:node'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const tool = String(req.params?.name ?? '');
      rpc.push({ user, tool });
      return { jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ ran: tool }) }] } };
    }) as unknown as OsToolDeps['handleRpc'],
    trace: (async () => undefined) as unknown as OsToolDeps['trace'],
  };
}

function harness(llm: LlmCall, spy: Spy, port: MemoryApprovalPort) {
  const sys = parseSystem(HELD_YAML);
  const deps: Omit<GraphDeps, 'checkpointer'> = {
    llm,
    toolSpecsFor: (node) => grantedToolSpecs(FIXTURE_USER, sys, node.tools),
    callTool: grantedToolExecutor(FIXTURE_USER, sys, SYSTEM_ID, spy, { holdAt: 'node' }),
    preamble: 'RULES',
    reasoningModel: 'reasoning',
    execModel: 'fast',
    maxIterations: 4,
    maxRunSteps: 20,
    hold: {
      decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
      approvals: port,
      systemId: SYSTEM_ID,
      domain: 'sales',
      runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
      agent: `os-${SYSTEM_ID}`,
    },
  };
  return { ir: compile(sys), deps };
}

const jobRow = (kind: 'start' | 'resume'): NewRunJob => ({
  runId: RUN_ID,
  systemId: SYSTEM_ID,
  domain: 'sales',
  requestedBy: FIXTURE_USER.id,
  principal: { id: FIXTURE_USER.id, name: FIXTURE_USER.name, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains, activeDomain: null },
  input: { messages: [{ role: 'user', content: TASK }], prompt: kind === 'start' ? TASK : undefined },
  kind,
});

/**
 * What `executeJob` does, minus the server wiring: claim, run the graph with the event sink
 * mirroring the engine hooks onto `run_events`, settle the row.
 */
async function drain(store: RunJobStore, h: ReturnType<typeof harness>, cp: ReturnType<typeof memoryCheckpointer>, resumeWith?: Record<string, 'approve' | 'reject'>): Promise<EngineRunResult> {
  const job = await store.claim('worker-test');
  assert.ok(job, 'a queued job to claim');
  const sink = runEventSink(store, job.runId);
  const result = await runGraphEngine({
    ir: h.ir,
    deps: h.deps,
    messages: job.input.messages ?? [],
    runId: job.runId,
    owner: OWNER,
    checkpointer: cp,
    resume: job.kind === 'resume',
    resumeWith,
    hooks: {
      onNodeStart: (ev) => sink.write('node-started', ev),
      onStep: (ev) => sink.write('tool-step', { node: ev.node, tool: ev.step.tool, index: ev.index }),
      onNodeComplete: (ev) => sink.write('node-completed', { node: ev.node, status: ev.status }),
      onInterrupt: (ev) => sink.write('approval-required', { approvalId: ev.approvalId, tool: ev.tool, node: ev.node }),
    },
  });
  sink.write('done', { ok: result.reachedEnd, parked: result.parked, reachedEnd: result.reachedEnd, path: result.path, finalText: result.finalText, heldApprovals: result.heldApprovals });
  await sink.drained();
  assert.deepEqual(sink.problems(), []);
  await store.complete(job.runId, result.parked ? 'parked' : 'done');
  return result;
}

test('A4+P3: a queued run parks on an approval; the DECISION files a resume job that finishes it, and the write runs once as the runner', async () => {
  const store = memoryRunJobStore();
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const h = harness(script(), spy, port);
  const cp = memoryCheckpointer();

  // 1) The run is FILED, then drained (inline mode does this in the same process; worker mode in
  //    the worker — the code path under test is the same).
  await store.enqueue(jobRow('start'));
  const first = await drain(store, h, cp);
  assert.equal(first.parked, true);
  assert.deepEqual(spy.rpc, [], 'nothing executed before the decision — not even the read in the batch');
  assert.equal((await store.get(RUN_ID))?.status, 'parked', 'a parked job is settled but NOT finished');

  const approvalId = first.heldApprovals[0].approvalId;
  assert.equal(port.all()[0].runId, RUN_ID);

  // 2) The approver decides. The hook files a `resume` job on the SAME row (one row per run) and
  //    writes the `resumed` frame before it, so the log reads in causal order.
  assert.ok(port.decide(approvalId, 'approve', 'domain-admin-dana'));
  await store.appendEvent(RUN_ID, 'resumed', { approvalId, decision: 'approve' });
  const requeued = await store.enqueue(jobRow('resume'));
  assert.equal(requeued.kind, 'resume');
  assert.equal(requeued.attempts, 0);

  // 3) The resume job continues the THREAD (the checkpoint), not a new run.
  const second = await drain(store, h, cp, { [approvalId]: 'approve' });
  assert.equal(second.parked, false);
  assert.equal(second.reachedEnd, true);
  assert.deepEqual(second.path, ['writer']);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge', 'request_promotion'], 'each call executed exactly once');
  for (const c of spy.rpc) assert.equal(c.user.id, FIXTURE_USER.id, 'as the RUNNER, never the approver');
  assert.equal((await store.get(RUN_ID))?.status, 'done');

  // 4) A panel tailing from seq 0 sees the whole story, in order, from the table alone.
  const seen: string[] = [];
  const out = await tailRunEvents(store, RUN_ID, { until: 'settled', afterSeq: 0, pollMs: 1 }, (e) => seen.push(e.event));
  assert.equal(out.ended, 'terminal');
  assert.deepEqual(seen, [
    'node-started',
    'approval-required',
    'done',       // parked — NOT terminal
    'resumed',
    // No second `node-started`: the resume re-enters `tools_writer` mid-node, so the panel sees
    // the continuation of the node it was already showing.
    'tool-step',
    'tool-step',
    'node-completed',
    'done',       // terminal
  ]);

  // 5) And a client that had already rendered up to the parked `done` gets only the continuation.
  const afterPark = seen.indexOf('resumed');
  const missed: string[] = [];
  await tailRunEvents(store, RUN_ID, { until: 'terminal', afterSeq: afterPark, pollMs: 1 }, (e) => missed.push(e.event));
  assert.deepEqual(missed, seen.slice(afterPark));
});

test('A4+P3: rejecting also resumes through the queue — the model gets the typed result and the run finishes', async () => {
  const store = memoryRunJobStore();
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const h = harness(script(), spy, port);
  const cp = memoryCheckpointer();

  await store.enqueue(jobRow('start'));
  const first = await drain(store, h, cp);
  const approvalId = first.heldApprovals[0].approvalId;
  assert.ok(port.decide(approvalId, 'reject', 'domain-admin-dana'));
  await store.appendEvent(RUN_ID, 'resumed', { approvalId, decision: 'reject' });
  await store.enqueue(jobRow('resume'));
  const second = await drain(store, h, cp, { [approvalId]: 'reject' });

  assert.equal(second.reachedEnd, true);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge'], 'the rejected write never executed');
  assert.equal((await store.get(RUN_ID))?.status, 'done');
  const events = await store.eventsAfter(RUN_ID, 0);
  assert.equal(events.at(-1)?.event, 'done');
  assert.equal((events.at(-1)?.data as { parked: boolean }).parked, false);
});
