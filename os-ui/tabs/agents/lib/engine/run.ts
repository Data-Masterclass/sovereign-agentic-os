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
 *   - INTERRUPT → CARD (WP-26). The graph never touches the Governance queue. This driver's stream
 *     loop sees each `__interrupt__` chunk (`{ id, value }`, one per held call) and files ONE card
 *     per interrupt: `approvals.enqueueOnce({ interruptKey: '<thread>:<interruptId>' })`. The
 *     interrupt id is LangGraph's, stable across re-runs of the paused node, so a worker restart
 *     or a replay never files a second card. It logs `parked runId=<id> interrupt=<id>`.
 *   - Resume = `stream(null | Command({ resume: { [interruptId]: { decision, approvalId } } }))`:
 *     LangGraph continues from the last checkpoint of that thread. STRICT: before building the
 *     Command, `getState` must list that interrupt id among the thread's pending interrupts —
 *     otherwise `StaleResumeError` (409) and nothing runs. A decision that names only its approval
 *     (a card or job filed before WP-26) is matched through the card, or — the one-release shim —
 *     to a pre-WP-26 thread's single pending interrupt; a pre-WP-26 batch holding more than one
 *     call is refused (`legacy_multi_hold`) so it is visibly cancelled, never guessed.
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
  isHoldInterrupt,
  isLegacyHoldInterrupt,
  type EngineEvent,
  type EngineState,
  type GraphDeps,
  type HeldCall,
  type HoldAnswer,
  type HoldDeps,
  type HoldInterrupt,
  type LegacyHoldInterrupt,
  type RouteDecision,
} from '@tabs/agents/lib/engine/build-graph';
import type { ApprovalDecision, RunOwner } from '@tabs/agents/lib/engine/approval-port';
import type { CheckpointerKind, SelectedCheckpointer } from '@tabs/agents/lib/engine/checkpointer';

/** The live hooks — the walker's three, plus A2's interrupt notice (the route's `approval-required`). */
export type EngineHooks = Pick<AgenticGraphDeps, 'onNodeStart' | 'onStep' | 'onNodeComplete'> & {
  /** A held call paused the run and its card was filed (once per interrupt id). */
  onInterrupt?: (ev: PendingApproval) => void;
  /** An agent is waiting for the model rate limit to reset (the route's `rate-limit-wait`). */
  onRateLimitWait?: (ev: Extract<EngineEvent, { event: 'rate-limit-wait' }>['data']) => void;
};

/** An approval a parked run is waiting on: the card, and the LangGraph interrupt it answers. */
export type PendingApproval = { approvalId: string; interruptId: string; tool: string; node: string };

/** A Governance decision delivered to a parked run. `interruptId` absent = a pre-WP-26 card or job. */
export type ResumeDecision = { decision: ApprovalDecision; approvalId: string; interruptId?: string };

/**
 * The decision names no interrupt this thread is waiting on (a duplicate, a stale card, a wrong
 * id), or — `legacy_multi_hold` — a pre-WP-26 thread whose parked batch holds more than one call.
 * 409; nothing runs. `stillParked` = the thread is still waiting on another interrupt.
 */
export class StaleResumeError extends Error {
  runId: string;
  status: number;
  code: 'stale_interrupt' | 'legacy_multi_hold';
  stillParked: boolean;
  constructor(runId: string, code: 'stale_interrupt' | 'legacy_multi_hold', reason: string, stillParked: boolean) {
    super(`Run '${runId}': ${reason}`);
    this.name = 'StaleResumeError';
    this.runId = runId;
    this.status = 409;
    this.code = code;
    this.stillParked = stillParked;
  }
}

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
  /** The Governance decision this resume delivers (WP-26: keyed by interrupt id). */
  resumeDecision?: ResumeDecision;
  /** ONE-RELEASE SHIM: a pre-WP-26 job's `{ [approvalId]: decision }` (exactly one entry). */
  resumeWith?: Record<string, ApprovalDecision>;
  /** Operator log line sink (the worker's console); absent → silent. */
  log?: (message: string) => void;
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
  /** An agent FAILED and the run stopped there. Never true for a parked, interrupted or budget-stopped run. */
  failed: boolean;
  /** Which agent failed and why (`node` is null when the failure has no visit on record). */
  failure?: RunFailure;
  /** A3: the Langfuse trace id (`createTraceId(runId)` when observed, else the run id) and whether an observer recorded this run. */
  traceId: string;
  observed: boolean;
};

/** The agent a run failed at, and the reason it gave. */
/** `code` is the typed cause when the engine knows one (e.g. `model_call_limit`, module engine). */
export type RunFailure = { node: string | null; reason: string; code?: string };

/** Read a run's failure out of its state: the engine's `failed` channel, else a failed visit. */
function failureOf(state: Partial<EngineState>): RunFailure | undefined {
  const runs: NodeRun[] = state.nodeRuns ?? [];
  const failedRun = [...runs].reverse().find((r) => r.status === 'failed');
  if (!state.failed && !failedRun) return undefined;
  return { node: failedRun?.node ?? null, reason: state.failed || failedRun?.error || 'an agent failed' };
}

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

/** Every run stream is checkpointed synchronously (see `runGraphEngine`). */
export const RUN_DURABILITY = 'sync' as const;

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
  else if (ev.event === 'rate-limit-wait') hooks.onRateLimitWait?.(ev.data);
}

function isEngineEvent(v: unknown): v is EngineEvent {
  return !!v && typeof v === 'object' && typeof (v as { event?: unknown }).event === 'string' && 'data' in (v as object);
}

type HoldPending = { id: string; value: HoldInterrupt | LegacyHoldInterrupt };

/** The thread's pending HOLD interrupts, from LangGraph's own state (`tasks[].interrupts[]`). */
function pendingHolds(snap: { tasks?: readonly { interrupts?: readonly { id?: string; value?: unknown }[] }[] }): HoldPending[] {
  const out: HoldPending[] = [];
  for (const t of snap.tasks ?? []) {
    for (const i of t.interrupts ?? []) {
      const v = i.value;
      if (i.id && (isHoldInterrupt(v) || isLegacyHoldInterrupt(v))) out.push({ id: i.id, value: v });
    }
  }
  return out;
}

/** The card for one pending interrupt: filed once (`file`), or only looked up (inspection). */
async function cardFor(runId: string, p: HoldPending, hold: HoldDeps | undefined, file: boolean): Promise<PendingApproval> {
  const base = { interruptId: p.id, tool: p.value.tool, node: p.value.node };
  // A pre-WP-26 thread: its card was filed inside the node and the value names it.
  if (isLegacyHoldInterrupt(p.value)) return { ...base, approvalId: p.value.approvalId };
  if (!hold) return { ...base, approvalId: '' };
  const interruptKey = `${runId}:${p.id}`;
  if (!file) return { ...base, approvalId: (await hold.approvals.find(interruptKey))?.approvalId ?? '' };
  const v = p.value;
  const { approvalId } = await hold.approvals.enqueueOnce({
    interruptKey,
    runId,
    threadId: runId,
    systemId: hold.systemId,
    node: v.node,
    tool: v.tool,
    args: v.args,
    approverRole: v.approverRole,
    domain: hold.domain,
    runner: hold.runner,
    agent: hold.agent,
  });
  return { ...base, approvalId };
}

/**
 * The interrupt id a card answers: cards are keyed `<thread>:<interruptId>` (WP-26). A card filed
 * before WP-26 is keyed `<thread>:<callId>`; its "id" will not match any pending interrupt and the
 * strict resume refuses it — so callers pass it only as a hint; `resolveResume` decides.
 */
export function interruptIdOfCard(interruptKey: string | undefined, threadId: string): string | undefined {
  if (!interruptKey || !interruptKey.startsWith(`${threadId}:`)) return undefined;
  const id = interruptKey.slice(threadId.length + 1);
  // LangGraph interrupt ids are hex digests (XXH3); a pre-WP-26 call id is not.
  return /^[0-9a-f]{16,}$/.test(id) ? id : undefined;
}

/**
 * STRICT RESUME (WP-26): which pending interrupt this decision answers. Throws `StaleResumeError`
 * rather than resuming anything else. Pure apart from the card lookup.
 */
export async function resolveResume(
  snap: { values?: unknown; tasks?: readonly { interrupts?: readonly { id?: string; value?: unknown }[] }[] },
  d: ResumeDecision,
  runId: string,
  hold: HoldDeps | undefined,
): Promise<string> {
  const pending = pendingHolds(snap);
  const stillParked = pending.length > 0;
  if (d.interruptId) {
    if (pending.some((p) => p.id === d.interruptId)) return d.interruptId;
    throw new StaleResumeError(runId, 'stale_interrupt', `interrupt '${d.interruptId}' is not pending on this run — the decision is stale or for another run; nothing was resumed`, stillParked);
  }
  // No interrupt id: a card or job filed before WP-26. (1) A current thread: match via its card.
  if (hold) {
    for (const p of pending) {
      if (!isHoldInterrupt(p.value)) continue;
      const card = await hold.approvals.find(`${runId}:${p.id}`);
      if (card?.approvalId === d.approvalId) return p.id;
    }
  }
  // (2) ONE-RELEASE SHIM: a thread parked by the previous engine — its value names the approval.
  const legacy = pending.filter((p) => isLegacyHoldInterrupt(p.value) && p.value.approvalId === d.approvalId);
  if (legacy.length === 1) {
    const cur = (snap.values as Partial<EngineState> | undefined)?.current;
    const heldInBatch = (cur?.pending ?? []).filter((c) => hold?.decide(c.name).held).length;
    if (pending.length !== 1 || heldInBatch !== 1) {
      throw new StaleResumeError(runId, 'legacy_multi_hold', `this run was parked by the previous engine with ${Math.max(heldInBatch, pending.length)} held calls in one batch; it cannot be resumed safely and is cancelled — start it again`, false);
    }
    return legacy[0].id;
  }
  throw new StaleResumeError(runId, 'stale_interrupt', `approval '${d.approvalId}' answers no interrupt pending on this run; nothing was resumed`, stillParked);
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
  if (snap.next.length === 0 && pendingHolds(snap).length === 0) throw new RunAlreadyFinishedError(runId);
  return snap;
}

/** Drive one run (or resume it) and assemble the report from graph state. */
export async function runGraphEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const built = buildGraph(input.ir, { ...input.deps, checkpointer: input.checkpointer.saver });
  const config = { configurable: { thread_id: input.runId }, recursionLimit: built.recursionLimit, signal: input.signal };

  let graphInput: Partial<EngineState> | Command | null = null;
  if (input.resume) {
    const snap = await assertResumable(built.graph, config, input.runId, input.owner);
    const decision = input.resumeDecision ?? legacyDecision(input.resumeWith);
    if (decision) {
      const interruptId = await resolveResume(snap, decision, input.runId, input.deps.hold);
      const answer: HoldAnswer = { decision: decision.decision, approvalId: decision.approvalId };
      graphInput = new Command({ resume: { [interruptId]: answer } });
      input.log?.(`resume runId=${input.runId} interrupt=${interruptId} decision=${decision.decision}`);
    }
  } else {
    const messages: LlmMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
    const task = input.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    graphInput = { messages, task, owner: input.owner ?? null };
  }

  let recursionHit = false;
  try {
    // DURABILITY 'sync' (WP-26): LangGraph awaits each superstep's checkpoint before the next one
    // starts, so a worker killed mid-run never re-executes a tool call that already completed.
    // With the default 'async' the write can still be in flight when the process dies (proven by
    // `durability.pg.test.ts`). One awaited write per superstep is negligible next to a model call.
    const stream = await built.graph.stream(graphInput, { ...config, streamMode: ['custom', 'updates'], durability: RUN_DURABILITY });
    for await (const chunk of stream) {
      const [mode, data] = chunk as [string, unknown];
      if (mode === 'custom' && isEngineEvent(data)) dispatch(data, input.hooks);
      else if (mode === 'updates' && data && typeof data === 'object' && '__interrupt__' in (data as object)) {
        // THE PROJECTOR: one card per LangGraph interrupt, keyed by its id (idempotent).
        const list = (data as { __interrupt__?: { id?: string; value?: unknown }[] }).__interrupt__ ?? [];
        for (const i of list) {
          const v = i.value;
          if (!i.id || !isHoldInterrupt(v)) continue;
          const card = await cardFor(input.runId, { id: i.id, value: v }, input.deps.hold, true);
          input.log?.(`parked runId=${input.runId} interrupt=${i.id} approval=${card.approvalId} tool=${card.tool}`);
          input.hooks?.onInterrupt?.(card);
        }
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
  // Every pending interrupt has its card (filed above; `enqueueOnce` answers the existing one).
  const heldApprovals = await Promise.all(pendingHolds(snap).map((p) => cardFor(input.runId, p, input.deps.hold, true)));
  const result = summarize(snap, built, input, recursionHit, heldApprovals);
  // A3: close the trace segment and flush in the background — never awaited by the run.
  const observer = input.deps.observe;
  if (observer) {
    observer.finish({
      reachedEnd: result.reachedEnd,
      parked: result.parked,
      interrupted: result.interrupted,
      failed: result.failed,
      path: result.path,
      finalChars: result.finalText.length,
      stepsUsed: result.budget.stepsUsed,
    });
    void observer.flush();
  }
  return result;
}

/** A pre-WP-26 job's `{ [approvalId]: decision }` as a decision without an interrupt id. */
function legacyDecision(resumeWith: Record<string, ApprovalDecision> | undefined): ResumeDecision | undefined {
  const entries = Object.entries(resumeWith ?? {});
  if (entries.length === 0) return undefined;
  if (entries.length > 1) throw new Error('resumeWith: a resume delivers exactly one decision');
  return { approvalId: entries[0][0], decision: entries[0][1] };
}

function summarize(snap: Snapshot, built: ReturnType<typeof buildGraph>, input: Pick<EngineRunInput, 'runId' | 'checkpointer' | 'signal'> & { deps?: Pick<GraphDeps, 'observe'> }, recursionHit: boolean, heldApprovals: PendingApproval[]): EngineRunResult {
  const state = (snap.values ?? {}) as Partial<EngineState>;
  const runs: NodeRun[] = state.nodeRuns ?? [];
  const budget = state.budget ?? { stepsUsed: 0, exhausted: false };
  const parked = heldApprovals.length > 0;
  const pending = snap.next.length > 0 || parked;
  const interrupted = pending || !!input.signal?.aborted || recursionHit;

  let finalText = state.final || (runs.length > 0 ? runs[runs.length - 1].result.finalText : parked ? '(parked before the first agent finished)' : '(no agents ran)');
  if (budget.exhausted) finalText += BUDGET_NOTE;
  else if (parked) finalText += PARKED_NOTE;
  else if (recursionHit) finalText += RECURSION_NOTE;
  else if (interrupted) finalText += INTERRUPTED_NOTE;

  const failure = failureOf(state);
  const failed = !!failure;
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
    failed,
    ...(failure ? { failure } : {}),
    traceId: input.deps?.observe?.enabled ? input.deps.observe.traceId : input.runId,
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
  /** Every agent visit with its result, in order — what a declared output is saved from. */
  nodes: { node: string; status: string; finalText: string }[];
  finalText: string;
  budget: { stepsUsed: number; limit: number; exhausted: boolean };
  held: HeldCall[];
  warnings: string[];
  /** An agent failed and the run stopped there. */
  failed: boolean;
  failure?: RunFailure;
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
    return { exists: false, owner: null, finished: false, parked: false, heldApprovals: [], next: [], path: [], nodes: [], finalText: '', budget: { stepsUsed: 0, limit: built.stepBudget, exhausted: false }, held: [], warnings: built.warnings, failed: false };
  }
  const held = await Promise.all(pendingHolds(snap).map((p) => cardFor(input.runId, p, input.deps.hold, false)));
  const s = summarize(snap, built, { runId: input.runId, checkpointer: input.checkpointer }, false, held);
  return {
    exists: true,
    owner: recorded,
    finished: snap.next.length === 0 && !s.parked,
    parked: s.parked,
    heldApprovals: s.heldApprovals,
    next: [...snap.next],
    path: s.path,
    nodes: s.runs.map((r) => ({ node: r.node, status: r.status, finalText: r.result.finalText })),
    finalText: s.finalText,
    budget: s.budget,
    held: s.held,
    warnings: s.warnings,
    failed: s.failed,
    ...(s.failure ? { failure: s.failure } : {}),
  };
}
