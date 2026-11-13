/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    runGraphEngine — stream one checkpointed run (or resume one) and report it
 * USER STORY: As the run route, the scheduler and the MCP tool I want ONE function that drives a
 *             built graph to completion with thread id = run id, forwards the live events the
 *             panel already understands, resumes an interrupted thread on request, and hands
 *             back the same result shape the walker produced — so the three callers stay thin
 *             and cannot disagree.
 * ARCHITECTURE:
 *   - `graph.stream(input, { configurable: { thread_id: runId }, streamMode: ['custom','updates'],
 *     recursionLimit })`. Nodes emit `EngineEvent`s through `config.writer`; this module maps the
 *     `custom` chunks onto the walker's hook signatures (`onNodeStart` / `onStep` /
 *     `onNodeComplete`) so the route's SSE frames (`node-started`, `tool-step`, `node-completed`,
 *     `done`, `error`) are emitted UNCHANGED by the existing code.
 *   - Resume = `stream(null, sameConfig)`: LangGraph continues from the last checkpoint of that
 *     thread (re-running the superstep that was in flight). An unknown thread is a typed
 *     `ResumeNotFoundError`, never a silent fresh run.
 *   - The result is assembled from GRAPH STATE (`getState`), not from the event stream: path =
 *     the recorded visits, final text = `state.final` (+ the budget note when exhausted). An
 *     aborted stream (`signal`) or a hit recursion limit yields a result with `reachedEnd:false`
 *     and `interrupted:true` — what completed is reported, nothing is invented.
 *   - No `server-only`, no env: the checkpointer is passed in (`checkpointer.ts` chooses it).
 */
import { GraphRecursionError } from '@langchain/langgraph';
import type { IR } from '@tabs/agents/lib/langgraph-compile';
import type { LlmMessage } from '@core/runtime/agentic';
import type { AgenticGraphDeps, AgenticGraphResult, NodeRun } from '@tabs/agents/lib/build/agentic-graph';
import { buildGraph, type EngineEvent, type EngineState, type GraphDeps, type HeldCall, type RouteDecision } from '@tabs/agents/lib/engine/build-graph';
import type { CheckpointerKind, SelectedCheckpointer } from '@tabs/agents/lib/engine/checkpointer';

/** The live hooks — identical to the walker's so the run route forwards events unchanged. */
export type EngineHooks = Pick<AgenticGraphDeps, 'onNodeStart' | 'onStep' | 'onNodeComplete'>;

export type EngineRunInput = {
  ir: IR;
  /** Graph deps WITHOUT a checkpointer — `checkpointer` below is injected. */
  deps: Omit<GraphDeps, 'checkpointer'>;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Thread id = run id. */
  runId: string;
  /** Continue the thread `runId` from its last checkpoint instead of starting it. */
  resume?: boolean;
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
  /** True when the stream was aborted or the recursion limit hit before END — resumable. */
  interrupted: boolean;
  held: HeldCall[];
  routes: RouteDecision[];
  /** The team step budget and how much of it the run used. */
  budget: { stepsUsed: number; limit: number; exhausted: boolean };
};

export class ResumeNotFoundError extends Error {
  runId: string;
  constructor(runId: string) {
    super(`No checkpointed run '${runId}' to resume on this checkpointer`);
    this.name = 'ResumeNotFoundError';
    this.runId = runId;
  }
}

/** The same phrasing the walker appends — the Evaluate run-check detects it. */
export const BUDGET_NOTE =
  "\n\n_(The team stopped at the run's tool-step budget — it may not have finished. An admin can raise AGENT_TEAM_RUN_MAX_STEPS.)_";

const RECURSION_NOTE = '\n\n_(The run hit the graph recursion limit before finishing — resume to continue.)_';
const INTERRUPTED_NOTE = '\n\n_(The run was interrupted before finishing — resume to continue.)_';

function dispatch(ev: EngineEvent, hooks: EngineHooks | undefined): void {
  if (!hooks) return;
  if (ev.event === 'node-started') hooks.onNodeStart?.(ev.data);
  else if (ev.event === 'tool-step') hooks.onStep?.(ev.data);
  else if (ev.event === 'node-completed') hooks.onNodeComplete?.(ev.data);
}

function isEngineEvent(v: unknown): v is EngineEvent {
  return !!v && typeof v === 'object' && typeof (v as { event?: unknown }).event === 'string' && 'data' in (v as object);
}

/** Drive one run (or resume it) and assemble the report from graph state. */
export async function runGraphEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const built = buildGraph(input.ir, { ...input.deps, checkpointer: input.checkpointer.saver });
  const config = { configurable: { thread_id: input.runId }, recursionLimit: built.recursionLimit, signal: input.signal };

  let graphInput: Partial<EngineState> | null = null;
  if (input.resume) {
    const snap = await built.graph.getState(config);
    const hasThread = snap && (snap.next.length > 0 || (snap.values as EngineState | undefined)?.nodeRuns?.length);
    if (!hasThread) throw new ResumeNotFoundError(input.runId);
  } else {
    const messages: LlmMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
    const task = input.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    graphInput = { messages, task };
  }

  let recursionHit = false;
  try {
    const stream = await built.graph.stream(graphInput, { ...config, streamMode: ['custom', 'updates'] });
    for await (const chunk of stream) {
      const [mode, data] = chunk as [string, unknown];
      if (mode === 'custom' && isEngineEvent(data)) dispatch(data, input.hooks);
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
  const state = (snap.values ?? {}) as Partial<EngineState>;
  const runs: NodeRun[] = state.nodeRuns ?? [];
  const budget = state.budget ?? { stepsUsed: 0, exhausted: false };
  const pending = snap.next.length > 0;
  const interrupted = pending || !!input.signal?.aborted || recursionHit;

  let finalText = state.final || (runs.length > 0 ? runs[runs.length - 1].result.finalText : '(no agents ran)');
  if (budget.exhausted) finalText += BUDGET_NOTE;
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
    held: state.held ?? [],
    routes: state.routes ?? [],
    budget: { stepsUsed: budget.stepsUsed, limit: built.stepBudget, exhausted: budget.exhausted },
  };
}
