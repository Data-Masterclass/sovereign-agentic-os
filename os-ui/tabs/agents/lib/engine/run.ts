/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    runGraphEngine — stream one checkpointed run (or resume one) and report it
 * USER STORY: As the run route, the scheduler, the MCP tool and the approval-resume hook I want ONE
 *             function that drives a built graph to completion with thread id = run id, forwards the
 *             live events the panel already understands, resumes an interrupted or PARKED thread on
 *             request (only for its owner), and hands back the same result shape the walker produced
 *             — so the callers stay thin and cannot disagree.
 * ARCHITECTURE:
 *   - `graph.stream(input, { configurable: { thread_id: runId }, streamMode: ['custom','updates'],
 *     recursionLimit })`. Nodes emit `EngineEvent`s through `config.writer`; this module maps the
 *     `custom` chunks onto the walker's hook signatures (`onNodeStart` / `onStep` /
 *     `onNodeComplete`) so the route's SSE frames are emitted UNCHANGED by the existing code. An
 *     `__interrupt__` chunk (A2: a held write parked the run) is forwarded as `onInterrupt`.
 *   - OWNER STAMP + RESUME GATE (review H1): the first superstep writes `state.owner`; a resume must
 *     name the same `{ systemId, userId }` or it is a `ResumeNotFoundError` (the route answers 404,
 *     never confirming the thread exists). A thread with nothing left to run is a typed
 *     `RunAlreadyFinishedError` (409) — resuming it is never a silent no-op that rewrites history.
 *   - Resume = `stream(null | Command({ resume }), sameConfig)`: LangGraph continues from the last
 *     checkpoint of that thread (re-running the superstep that was in flight). `resumeWith` carries
 *     `{ [approvalId]: decision }` after a Governance decision (the node also re-reads the queue).
 *   - The result is assembled from GRAPH STATE (`getState`), not from the event stream: path = the
 *     recorded visits, final text = `state.final` (+ the budget note when exhausted); `heldApprovals`
 *     = the interrupts still pending (a PARKED run). An aborted stream or a hit recursion limit
 *     yields `reachedEnd:false` + `interrupted:true` — what completed is reported, nothing invented.
 *   - No `server-only`, no env: the checkpointer is passed in (`checkpointer.ts` chooses it).
 */
import { Command, GraphRecursionError } from '@langchain/langgraph';
import type { IR } from '@tabs/agents/lib/langgraph-compile';
import type { LlmMessage } from '@core/runtime/agentic';
import type { AgenticGraphDeps, AgenticGraphResult, NodeRun } from '@tabs/agents/lib/build/agentic-graph';
import {
  buildGraph,
  isInterruptPayload,
  type EngineEvent,
  type EngineState,
  type GraphDeps,
  type HeldCall,
  type InterruptPayload,
  type RouteDecision,
} from '@tabs/agents/lib/engine/build-graph';
import type { ApprovalDecision, RunOwner } from '@tabs/agents/lib/engine/approval-port';
import type { CheckpointerKind, SelectedCheckpointer } from '@tabs/agents/lib/engine/checkpointer';

/** The live hooks — the walker's three, plus A2's interrupt notice (the route's `approval-required`). */
export type EngineHooks = Pick<AgenticGraphDeps, 'onNodeStart' | 'onStep' | 'onNodeComplete'> & {
  onInterrupt?: (ev: InterruptPayload) => void;
};

/** An approval a parked run is waiting on. */
export type PendingApproval = { approvalId: string; tool: string; node: string };

export type EngineRunInput = {
  ir: IR;
  /** Graph deps WITHOUT a checkpointer — `checkpointer` below is injected. */
  deps: Omit<GraphDeps, 'checkpointer'>;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Thread id = run id. */
  runId: string;
  /** Who this run belongs to — stamped on start, VERIFIED on resume (review H1). */
  owner?: RunOwner;
  /** Continue the thread `runId` from its last checkpoint instead of starting it. */
  resume?: boolean;
  /** A2: the decision(s) a resume carries, `{ [approvalId]: 'approve' | 'reject' }`. */
  resumeWith?: Record<string, ApprovalDecision>;
  hooks?: EngineHooks;
  /** Abort the stream (a disconnect, a test killing the run) — the thread stays resumable. */
  signal?: AbortSignal;
  checkpointer: SelectedCheckpointer;
};

export type EngineRunResult = AgenticGraphResult & {
  engine: 'langgraph';
  runId: string;
  checkpointer: CheckpointerKind;
  /** Compile warnings from `buildGraph` (e.g. a guard over a channel nothing sets). */
  warnings: string[];
  /** True when the stream stopped before END (aborted, recursion limit, or PARKED on approvals) — resumable. */
  interrupted: boolean;
  /** A2: true when the run is waiting on `heldApprovals`; a Governance decision resumes it. */
  parked: boolean;
  heldApprovals: PendingApproval[];
  /** Held writes already decided and executed/rejected in this run. */
  held: HeldCall[];
  routes: RouteDecision[];
  /** The team step budget and how much of it the run used. */
  budget: { stepsUsed: number; limit: number; exhausted: boolean };
  /** A3: the Langfuse trace id (= run id) and whether an observer actually recorded this run. */
  traceId: string;
  observed: boolean;
};

export class ResumeNotFoundError extends Error {
  runId: string;
  status: number;
  constructor(runId: string) {
    super(`No checkpointed run '${runId}' to resume for this system and user`);
    this.name = 'ResumeNotFoundError';
    this.runId = runId;
    this.status = 404;
  }
}

/** The thread exists but has nothing left to run — resuming it would silently rewrite its record (review M4). */
export class RunAlreadyFinishedError extends Error {
  runId: string;
  status: number;
  constructor(runId: string) {
    super(`Run '${runId}' already finished — nothing to resume`);
    this.name = 'RunAlreadyFinishedError';
    this.runId = runId;
    this.status = 409;
  }
}

/** The same phrasing the walker appends — the Evaluate run-check detects it. */
export const BUDGET_NOTE =
  "\n\n_(The team stopped at the run's tool-step budget — it may not have finished. An admin can raise AGENT_TEAM_RUN_MAX_STEPS.)_";

const RECURSION_NOTE = '\n\n_(The run hit the graph recursion limit before finishing — resume to continue.)_';
const INTERRUPTED_NOTE = '\n\n_(The run was interrupted before finishing — resume to continue.)_';
const PARKED_NOTE = '\n\n_(The run is parked: a write is awaiting approval in Governance → Inbox. The decision resumes it.)_';

function dispatch(ev: EngineEvent, hooks: EngineHooks | undefined): void {
  if (!hooks) return;
  if (ev.event === 'node-started') hooks.onNodeStart?.(ev.data);
  else if (ev.event === 'tool-step') hooks.onStep?.(ev.data);
  else if (ev.event === 'node-completed') hooks.onNodeComplete?.(ev.data);
}

function isEngineEvent(v: unknown): v is EngineEvent {
  return !!v && typeof v === 'object' && typeof (v as { event?: unknown }).event === 'string' && 'data' in (v as object);
}

/** The pending interrupts of a state snapshot, as approvals (any other interrupt value is ignored). */
function pendingApprovals(snap: { tasks?: { interrupts?: { value?: unknown }[] }[] }): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const t of snap.tasks ?? []) {
    for (const i of t.interrupts ?? []) {
      if (isInterruptPayload(i.value)) out.push({ approvalId: i.value.approvalId, tool: i.value.tool, node: i.value.node });
    }
  }
  return out;
}

type Snapshot = Awaited<ReturnType<ReturnType<typeof buildGraph>['graph']['getState']>>;

/** True when the snapshot is a thread that was ever started (not an empty default state). */
function threadExists(snap: Snapshot | undefined): boolean {
  if (!snap) return false;
  const v = snap.values as Partial<EngineState> | undefined;
  return snap.next.length > 0 || !!v?.nodeRuns?.length || !!v?.owner;
}

/**
 * The resume gate: the thread must exist, must belong to `owner` (system AND user), and must have
 * something left to run. Throws the typed errors above; returns the snapshot.
 */
async function assertResumable(graph: ReturnType<typeof buildGraph>['graph'], config: Record<string, unknown>, runId: string, owner: RunOwner | undefined): Promise<Snapshot> {
  const snap = await graph.getState(config);
  if (!threadExists(snap)) throw new ResumeNotFoundError(runId);
  const recorded = (snap.values as Partial<EngineState>).owner ?? null;
  if (owner) {
    // Unknown owner on an old thread or a mismatch: the thread is NOT this caller's to resume.
    if (!recorded || recorded.systemId !== owner.systemId || recorded.userId !== owner.userId) throw new ResumeNotFoundError(runId);
  }
  // `next` lists only tasks WITHOUT writes; a task re-parked on a second `interrupt()` after a resume
  // already carries its `__resume__` write, so it is absent from `next` but present in `tasks` with
  // its interrupts — still resumable, not finished.
  if (snap.next.length === 0 && pendingApprovals(snap).length === 0) throw new RunAlreadyFinishedError(runId);
  return snap;
}

/** Drive one run (or resume it) and assemble the report from graph state. */
export async function runGraphEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const built = buildGraph(input.ir, { ...input.deps, checkpointer: input.checkpointer.saver });
  const config = { configurable: { thread_id: input.runId }, recursionLimit: built.recursionLimit, signal: input.signal };

  let graphInput: Partial<EngineState> | Command | null = null;
  if (input.resume) {
    await assertResumable(built.graph, config, input.runId, input.owner);
    if (input.resumeWith) graphInput = new Command({ resume: input.resumeWith });
  } else {
    const messages: LlmMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
    const task = input.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    graphInput = { messages, task, owner: input.owner ?? null };
  }

  let recursionHit = false;
  try {
    const stream = await built.graph.stream(graphInput, { ...config, streamMode: ['custom', 'updates'] });
    for await (const chunk of stream) {
      const [mode, data] = chunk as [string, unknown];
      if (mode === 'custom' && isEngineEvent(data)) dispatch(data, input.hooks);
      else if (mode === 'updates' && data && typeof data === 'object' && '__interrupt__' in (data as object)) {
        const list = (data as { __interrupt__?: { value?: unknown }[] }).__interrupt__ ?? [];
        for (const i of list) if (isInterruptPayload(i.value)) input.hooks?.onInterrupt?.(i.value);
      }
    }
  } catch (e) {
    if (input.signal?.aborted) {
      /* aborted by the caller — the thread stays resumable */
    } else if (e instanceof GraphRecursionError) {
      recursionHit = true;
    } else {
      throw e;
    }
  }

  const snap = await built.graph.getState(config);
  const result = summarize(snap, built, input, recursionHit);
  // A3: close the trace segment and flush in the background — never awaited by the run.
  const observer = input.deps.observe;
  if (observer) {
    observer.finish({
      reachedEnd: result.reachedEnd,
      parked: result.parked,
      interrupted: result.interrupted,
      failed: !!(snap.values as Partial<EngineState> | undefined)?.failed,
      path: result.path,
      finalChars: result.finalText.length,
      stepsUsed: result.budget.stepsUsed,
    });
    void observer.flush();
  }
  return result;
}

function summarize(snap: Snapshot, built: ReturnType<typeof buildGraph>, input: Pick<EngineRunInput, 'runId' | 'checkpointer' | 'signal'> & { deps?: Pick<GraphDeps, 'observe'> }, recursionHit: boolean): EngineRunResult {
  const state = (snap.values ?? {}) as Partial<EngineState>;
  const runs: NodeRun[] = state.nodeRuns ?? [];
  const budget = state.budget ?? { stepsUsed: 0, exhausted: false };
  const heldApprovals = pendingApprovals(snap);
  const parked = heldApprovals.length > 0;
  const pending = snap.next.length > 0 || parked;
  const interrupted = pending || !!input.signal?.aborted || recursionHit;

  let finalText = state.final || (runs.length > 0 ? runs[runs.length - 1].result.finalText : parked ? '(parked before the first agent finished)' : '(no agents ran)');
  if (budget.exhausted) finalText += BUDGET_NOTE;
  else if (parked) finalText += PARKED_NOTE;
  else if (recursionHit) finalText += RECURSION_NOTE;
  else if (interrupted) finalText += INTERRUPTED_NOTE;

  const failed = !!state.failed || runs.some((r) => r.status === 'failed');
  return {
    path: runs.map((r) => r.node),
    runs,
    finalText,
    reachedEnd: runs.length > 0 && !failed && !budget.exhausted && !interrupted,
    engine: 'langgraph',
    runId: input.runId,
    checkpointer: input.checkpointer.kind,
    warnings: built.warnings,
    interrupted,
    parked,
    heldApprovals,
    held: state.held ?? [],
    routes: state.routes ?? [],
    budget: { stepsUsed: budget.stepsUsed, limit: built.stepBudget, exhausted: budget.exhausted },
    traceId: input.runId,
    observed: !!input.deps?.observe?.enabled,
  };
}

export type RunInspection = {
  exists: boolean;
  /** The owner stamp (system, user, domain) — null on a thread older than A2. */
  owner: RunOwner | null;
  /** Nothing left to run. */
  finished: boolean;
  parked: boolean;
  heldApprovals: PendingApproval[];
  /** The LangGraph nodes queued next (empty when finished). */
  next: string[];
  path: string[];
  finalText: string;
  budget: { stepsUsed: number; limit: number; exhausted: boolean };
  held: HeldCall[];
  warnings: string[];
};

/**
 * Read a run's state WITHOUT running anything (the MCP `get_agent_run`). The owner gate applies when
 * `owner` is given: a thread that is not this system + user's reads as `exists:false`.
 */
export async function inspectGraphRun(input: Pick<EngineRunInput, 'ir' | 'deps' | 'runId' | 'owner' | 'checkpointer'>): Promise<RunInspection> {
  const built = buildGraph(input.ir, { ...input.deps, checkpointer: input.checkpointer.saver });
  const config = { configurable: { thread_id: input.runId } };
  const snap = await built.graph.getState(config);
  const recorded = ((snap.values ?? {}) as Partial<EngineState>).owner ?? null;
  const mine = !input.owner || (!!recorded && recorded.systemId === input.owner.systemId && recorded.userId === input.owner.userId);
  if (!threadExists(snap) || !mine) {
    return { exists: false, owner: null, finished: false, parked: false, heldApprovals: [], next: [], path: [], finalText: '', budget: { stepsUsed: 0, limit: built.stepBudget, exhausted: false }, held: [], warnings: built.warnings };
  }
  const s = summarize(snap, built, { runId: input.runId, checkpointer: input.checkpointer }, false);
  return {
    exists: true,
    owner: recorded,
    finished: snap.next.length === 0 && !s.parked,
    parked: s.parked,
    heldApprovals: s.heldApprovals,
    next: [...snap.next],
    path: s.path,
    finalText: s.finalText,
    budget: s.budget,
    held: s.held,
    warnings: s.warnings,
  };
}
