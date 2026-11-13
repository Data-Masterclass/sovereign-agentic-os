/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    P3 — approvals as interrupts (A15–A17) plus the A1-review fixes H1, M4, M5
 * USER STORY: As the engine-rebuild engineer I want proof that a held write never executes before
 *             the decision; that approving executes it exactly once AS THE RUNNER; that a rejection
 *             reaches the model as a typed result and the run continues; that a batch with one held
 *             and one non-held call executes the non-held exactly once across the interrupt/resume
 *             re-run and across a crash between two executions; that a racing second decision resumes
 *             nothing; and that a thread can only be resumed by its own system + runner, never once
 *             it has finished.
 * ARCHITECTURE:
 *   - Pure: `runGraphEngine` over a private MemorySaver, the REAL `grantedToolSpecs` /
 *     `grantedToolExecutor` (with `holdAt:'node'`, as production wires the langgraph engine), a spy
 *     `handleRpc` that records the acting user, the pure `holdDecisionFor` rule and the in-memory
 *     `ApprovalPort`. A scripted model issues the tool batch on its first ACT and answers FINAL on
 *     the next. No server-only module, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { memoryApprovalPort, type MemoryApprovalPort, type RunOwner } from '@tabs/agents/lib/engine/approval-port';
import type { GraphDeps, InterruptPayload } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer, type SelectedCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { inspectGraphRun, ResumeNotFoundError, RunAlreadyFinishedError, runGraphEngine, type EngineRunInput } from '@tabs/agents/lib/engine/run';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';

const SYSTEM_ID = 'sys-held';
const OWNER: RunOwner = { systemId: SYSTEM_ID, userId: FIXTURE_USER.id, domain: 'sales' };
const TASK = 'File the promotion of the Q3 findings.';

/** One agent, a read tool and ONE escalating write the read-propose preset holds for a domain_admin. */
const HELD_YAML = `version: '1'
system: { name: held, domain: sales, visibility: Personal }
safety_preset: read-propose
entrypoint: writer
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, request_promotion], connections: [] }
agents:
  - { id: writer, role: writes, agent_md: '# writer', memory_md: '# Memory', tools: [search_knowledge, request_promotion] }
edges: []
`;

/** Two READ tools (nothing held) — for the crash-between-executions case. */
const READS_YAML = HELD_YAML.replace(/request_promotion/g, 'query_data');

type Call = { id: string; name: string; args: Record<string, unknown> };

/** PLAN → fixed; first ACT → the given batch; every later ACT → FINAL. Records every ACT request. */
function script(batch: Call[], acts: LlmRequest[] = []): LlmCall {
  let n = 0;
  return async (req) => {
    if (!req.tools) return { content: 'plan: do it', toolCalls: [] };
    acts.push(req);
    n += 1;
    if (n === 1) return { content: '', toolCalls: batch };
    return { content: 'FINAL(writer)', toolCalls: [] };
  };
}

type Spy = OsToolDeps & { rpc: { user: CurrentUser; tool: string }[] };

/** The REAL gates with an echo dispatch that records WHO each governed call ran as. */
function spyDeps(opts: { failOnce?: string } = {}): Spy {
  const rpc: Spy['rpc'] = [];
  let failed = false;
  const deps: Spy = {
    rpc,
    enqueue: (() => { throw new Error('the executor must not hold under holdAt:node'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const tool = String(req.params?.name ?? '');
      if (opts.failOnce && tool === opts.failOnce && !failed) {
        failed = true;
        throw new Error('crash mid-batch');
      }
      rpc.push({ user, tool });
      return { jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ ran: tool }) }] } };
    }) as unknown as OsToolDeps['handleRpc'],
    trace: (async () => undefined) as unknown as OsToolDeps['trace'],
  };
  return deps;
}

function harness(yaml: string, llm: LlmCall, spy: Spy, port: MemoryApprovalPort) {
  const sys = parseSystem(yaml);
  const ir = compile(sys);
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
  return { ir, deps };
}

function runInput(h: ReturnType<typeof harness>, runId: string, cp: SelectedCheckpointer, extra: Partial<EngineRunInput> = {}): EngineRunInput {
  return { ir: h.ir, deps: h.deps, messages: [{ role: 'user', content: TASK }], runId, owner: OWNER, checkpointer: cp, ...extra };
}

const BATCH: Call[] = [
  { id: 'c-read', name: 'search_knowledge', args: { q: 'Q3 findings' } },
  { id: 'c-write', name: 'request_promotion', args: { id: 'kn_q3' } },
];

test('P3(a)+(d) a held write PARKS the run before anything executes; the non-held call of the same batch waits too', async () => {
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const interrupts: InterruptPayload[] = [];
  const h = harness(HELD_YAML, script(BATCH), spy, port);
  const cp = memoryCheckpointer();

  const r1 = await runGraphEngine(runInput(h, 'held-a', cp, { hooks: { onInterrupt: (ev) => interrupts.push(ev) } }));
  assert.equal(r1.parked, true, 'the run is parked');
  assert.equal(r1.interrupted, true);
  assert.equal(r1.reachedEnd, false);
  assert.deepEqual(r1.heldApprovals.map((x) => ({ tool: x.tool, node: x.node })), [{ tool: 'request_promotion', node: 'writer' }]);
  assert.equal(interrupts.length, 1, 'approval-required fired once');
  assert.equal(interrupts[0].approvalId, r1.heldApprovals[0].approvalId);
  assert.match(r1.finalText, /parked/);
  // NOTHING executed — not the held write, not even the read in the same batch.
  assert.deepEqual(spy.rpc, []);
  // ONE approval in the queue, pending, carrying the thread and the runner.
  const all = port.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'pending');
  assert.equal(all[0].runId, 'held-a');
  assert.equal(all[0].interruptKey, 'held-a:c-write');
  assert.equal(all[0].runner.id, FIXTURE_USER.id);
  assert.equal(all[0].approverRole, 'domain_admin');

  // The inspection view sees the parked run; a foreign owner sees nothing.
  const mine = await inspectGraphRun({ ir: h.ir, deps: h.deps, runId: 'held-a', owner: OWNER, checkpointer: cp });
  assert.equal(mine.exists, true);
  assert.equal(mine.parked, true);
  assert.deepEqual(mine.heldApprovals, r1.heldApprovals);
  const theirs = await inspectGraphRun({ ir: h.ir, deps: h.deps, runId: 'held-a', owner: { ...OWNER, userId: 'someone-else' }, checkpointer: cp });
  assert.equal(theirs.exists, false);
});

test('P3(b)+(d) approve → the held write executes EXACTLY ONCE as the RUNNER (not the approver); the non-held call exactly once across the re-run', async () => {
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const h = harness(HELD_YAML, script(BATCH), spy, port);
  const cp = memoryCheckpointer();
  const r1 = await runGraphEngine(runInput(h, 'held-b', cp));
  const approvalId = r1.heldApprovals[0].approvalId;

  const decided = port.decide(approvalId, 'approve', 'domain-admin-dana');
  assert.ok(decided, 'the first decision transitions the record');
  const r2 = await runGraphEngine(runInput(h, 'held-b', cp, { resume: true, resumeWith: { [approvalId]: 'approve' } }));
  assert.equal(r2.parked, false);
  assert.equal(r2.reachedEnd, true);
  assert.deepEqual(r2.path, ['writer']);
  assert.equal(r2.finalText, 'FINAL(writer)');
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge', 'request_promotion'], 'each call executed once, in batch order');
  for (const c of spy.rpc) assert.equal(c.user.id, FIXTURE_USER.id, `executed as the runner, not the approver: ${c.tool}`);
  assert.deepEqual(r2.held, [{ node: 'writer', tool: 'request_promotion', callId: 'c-write', approvalId, decision: 'approve' }]);
  // The node re-ran from its start on resume: enqueueOnce was asked again, but ONE record exists.
  assert.ok(port.enqueueCalls >= 2, `enqueueOnce re-asked on the re-run (${port.enqueueCalls})`);
  assert.equal(port.all().length, 1, 'idempotent on (threadId, callId)');
  const step = r2.runs[0].result.steps.find((s) => s.tool === 'request_promotion')!;
  assert.equal(step.isError, false);
  assert.match(step.result, /"ran":"request_promotion"/);
});

test('P3(c) reject → a typed `rejected` result reaches the model and the run continues to END; the write never executes', async () => {
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const acts: LlmRequest[] = [];
  const h = harness(HELD_YAML, script(BATCH, acts), spy, port);
  const cp = memoryCheckpointer();
  const r1 = await runGraphEngine(runInput(h, 'held-c', cp));
  const approvalId = r1.heldApprovals[0].approvalId;
  assert.ok(port.decide(approvalId, 'reject', 'domain-admin-dana'));

  const r2 = await runGraphEngine(runInput(h, 'held-c', cp, { resume: true, resumeWith: { [approvalId]: 'reject' } }));
  assert.equal(r2.reachedEnd, true, 'the run continued to END');
  assert.equal(r2.parked, false);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge'], 'the rejected write never reached the executor');
  assert.deepEqual(r2.held, [{ node: 'writer', tool: 'request_promotion', callId: 'c-write', approvalId, decision: 'reject' }]);
  // The model's next ACT saw the typed rejection as the tool result.
  const last = acts.at(-1)!;
  const toolMsg = last.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c-write');
  assert.ok(toolMsg, 'a tool message for the held call reached the model');
  const parsed = JSON.parse(toolMsg!.content) as { error: { code: string; approvalId: string } };
  assert.equal(parsed.error.code, 'rejected');
  assert.equal(parsed.error.approvalId, approvalId);
  const step = r2.runs[0].result.steps.find((s) => s.tool === 'request_promotion')!;
  assert.equal(step.isError, true);
  assert.equal(r2.runs[0].status, 'denied', 'a human rejection is a policy outcome, not an execution failure');
});

test('P3(e) a racing second decision gets null and resumes nothing; a resume payload for ANOTHER approval does not unblock this one', async () => {
  const spy = spyDeps();
  const port = memoryApprovalPort();
  // Two held writes in one batch plus a read.
  const batch: Call[] = [
    { id: 'c-read', name: 'search_knowledge', args: { q: 'x' } },
    { id: 'c-w1', name: 'request_promotion', args: { id: 'kn_1' } },
    { id: 'c-w2', name: 'request_promotion', args: { id: 'kn_2' } },
  ];
  const h = harness(HELD_YAML, script(batch), spy, port);
  const cp = memoryCheckpointer();
  const r1 = await runGraphEngine(runInput(h, 'held-e', cp));
  // Both approvals are filed at once (the inbox shows the whole batch); the run parks on the first.
  assert.equal(port.all().length, 2);
  assert.equal(r1.heldApprovals.length, 1);
  const [a1, a2] = port.all().map((x) => x.approvalId);
  assert.equal(r1.heldApprovals[0].approvalId, a1);

  // Decide the SECOND first; the first stays pending → the run parks again on the first.
  assert.ok(port.decide(a2, 'approve', 'dana'));
  assert.equal(port.decide(a2, 'reject', 'eve'), null, 'the racing second decider gets null');
  const r2 = await runGraphEngine(runInput(h, 'held-e', cp, { resume: true, resumeWith: { [a2]: 'approve' } }));
  assert.equal(r2.parked, true, 'still parked: the first approval is undecided');
  assert.equal(r2.heldApprovals[0].approvalId, a1);
  assert.deepEqual(spy.rpc, [], 'nothing executed while any call of the batch is undecided');

  // Now decide the first: both decisions are read back from the queue and the batch executes once.
  assert.ok(port.decide(a1, 'reject', 'dana'));
  const r3 = await runGraphEngine(runInput(h, 'held-e', cp, { resume: true, resumeWith: { [a1]: 'reject' } }));
  assert.equal(r3.parked, false);
  assert.equal(r3.reachedEnd, true);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge', 'request_promotion'], 'the read once, the approved write once, the rejected write never');
  assert.deepEqual(r3.held.map((x) => [x.callId, x.decision]), [['c-w1', 'reject'], ['c-w2', 'approve']]);
});

test('H1: a thread can be resumed only by its own system AND runner — anything else is a typed not-found before any execution', async () => {
  const spy = spyDeps();
  const port = memoryApprovalPort();
  const h = harness(HELD_YAML, script(BATCH), spy, port);
  const cp = memoryCheckpointer();
  const r1 = await runGraphEngine(runInput(h, 'held-h1', cp));
  const approvalId = r1.heldApprovals[0].approvalId;
  port.decide(approvalId, 'approve', 'dana');

  await assert.rejects(
    () => runGraphEngine(runInput(h, 'held-h1', cp, { resume: true, resumeWith: { [approvalId]: 'approve' }, owner: { ...OWNER, userId: 'user-b' } })),
    (e: Error) => e instanceof ResumeNotFoundError && (e as ResumeNotFoundError).status === 404,
    'another user cannot resume this run',
  );
  await assert.rejects(
    () => runGraphEngine(runInput(h, 'held-h1', cp, { resume: true, resumeWith: { [approvalId]: 'approve' }, owner: { ...OWNER, systemId: 'other-system' } })),
    (e: Error) => e instanceof ResumeNotFoundError,
    'a runId from another system is rejected',
  );
  await assert.rejects(
    () => runGraphEngine(runInput(h, 'never-started', cp, { resume: true })),
    (e: Error) => e instanceof ResumeNotFoundError,
  );
  assert.deepEqual(spy.rpc, [], 'a refused resume executed nothing');

  // The owner resumes fine — and resuming the FINISHED thread again is a typed conflict (M4).
  const r2 = await runGraphEngine(runInput(h, 'held-h1', cp, { resume: true, resumeWith: { [approvalId]: 'approve' } }));
  assert.equal(r2.reachedEnd, true);
  await assert.rejects(
    () => runGraphEngine(runInput(h, 'held-h1', cp, { resume: true })),
    (e: Error) => e instanceof RunAlreadyFinishedError && (e as RunAlreadyFinishedError).status === 409,
  );
  assert.equal(spy.rpc.length, 2, 'the finished run was not re-run');
});

test('M5: a crash between two executions of one batch re-executes only the call in flight — the first ran exactly once', async () => {
  const spy = spyDeps({ failOnce: 'query_data' });
  const port = memoryApprovalPort();
  const batch: Call[] = [
    { id: 'c-1', name: 'search_knowledge', args: { q: 'a' } },
    { id: 'c-2', name: 'query_data', args: { sql: 'select 1' } },
  ];
  const h = harness(READS_YAML, script(batch), spy, port);
  const cp = memoryCheckpointer();
  // The executor's dispatch throws on the SECOND call → the tools superstep fails after the first
  // call was checkpointed.
  await assert.rejects(() => runGraphEngine(runInput(h, 'crash', cp)), /crash mid-batch/);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge'], 'the first call ran before the crash');
  // Resume (restart recovery): LangGraph re-runs the in-flight superstep — the second call only.
  const r2 = await runGraphEngine(runInput(h, 'crash', cp, { resume: true }));
  assert.equal(r2.reachedEnd, true);
  assert.deepEqual(spy.rpc.map((c) => c.tool), ['search_knowledge', 'query_data'], 'search_knowledge executed exactly once across crash + resume');
  assert.deepEqual(r2.runs[0].result.steps.map((s) => s.tool), ['search_knowledge', 'query_data']);
  assert.equal(port.all().length, 0, 'read tools are never held');
});
