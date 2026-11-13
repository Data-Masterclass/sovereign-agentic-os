/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    buildGraph — a compiled system.yaml IR becomes a real LangGraph StateGraph
 * USER STORY: As a builder I want the team I described in system.yaml to execute as a genuine
 *             LangGraph graph — a supervisor that DECIDES who works next, handoff guards that
 *             actually route, bounded loops, and every superstep checkpointed — so what I built
 *             is what runs, and an engineer who knows LangGraph recognises the shape.
 * ARCHITECTURE:
 *   - Input: the UNCHANGED IR from `langgraph-compile.ts` plus injected deps (model caller,
 *     per-node tool specs, the governed executor, prompts, budgets, checkpointer). Output: a
 *     compiled `StateGraph` + compile warnings + the recursion limit. Pure apart from the
 *     injected collaborators; no `server-only`, so the parity tests drive it directly.
 *   - STATE (`Annotation.Root`): `messages` (OpenAI wire shape `LlmMessage[]`, append — NOT
 *     LangChain BaseMessage), every `state.channels` entry (`add_messages` → append, anything
 *     else → last value), plus the engine's own keys: `task`, `current` (the agent visit in
 *     flight), `handoffs` (append), `nodeRuns` (append), `routes` (append), `budget`, `held`
 *     (append), `final`, `failed`, `routeNext`. A system channel colliding with an engine key is
 *     a compile error.
 *   - FOUR NODES PER AGENT: `plan_<id>` (reasoning tier, no tools; budget check; node-started),
 *     `act_<id>` (execution tier with the node's advertised tools; ReAct fallback on
 *     ToolCallingUnsupportedError; dedup / error-streak / cap synthesis exactly as the walker's
 *     harness), `tools_<id>` (NODE-LEVEL NARROWING GATE — only tools this node is advertised
 *     reach the governed executor; A2: the HOLD DECISION for the whole batch is computed here
 *     first (`holdDecisionFor`), every held call is enqueued ONCE (`ApprovalPort.enqueueOnce`,
 *     idempotent on `<threadId>:<callId>`) and then parked on `interrupt()`; only after every
 *     decision is known do calls execute — ONE CALL PER SUPERSTEP so each execution is
 *     checkpointed before the next (a crash re-executes at most the call in flight); an
 *     approved call runs through the unchanged executor AS THE RUNNER, a rejected one returns
 *     the typed `rejected` result to the model, which continues), `route_<id>`
 *     (records the visit; handoffs in declared order via `when`; supervisor decision; member
 *     return; END). act → tools when the reply carries tool calls, else → route.
 *   - SUPERVISOR: `route_<sup>` asks the model through a mandatory `route` tool returning
 *     `{ next: <member>|'END', brief }` (text fallback `NEXT: <member>`), then
 *     `addConditionalEdges` fans out to members ∪ handoff targets ∪ END. A member's route
 *     returns to the supervisor's ROUTE node (one decision call per return — the standard
 *     LangGraph supervisor; see the plan's deviation A1-1). On END the brief, when given, is
 *     the team's final text; otherwise the last agent's.
 *   - HANDOFFS: `when` is evaluated by `./when.ts` (safe expressions, never eval); a true guard
 *     returns `new Command({ goto: 'plan_<to>' })`. Absent guard = unconditional. A guard over
 *     a channel nothing sets is a compile WARNING (returned, surfaced in Build), not a silent
 *     false.
 *   - END: the supervisor routes END; a leaf whose handoffs all evaluate false; or the team
 *     step budget is spent (graceful: `final` = what completed, `budget.exhausted`). The
 *     recursion limit is derived from the step budget (see `recursionLimitFor`).
 *   - Node ids are sanitised to valid LangGraph node names; disabled agents are pruned at
 *     build; unmapped legacy tools (passed in by the server wiring) are a compile error.
 *   - OWNER STAMP (review H1): the first superstep writes `state.owner = { systemId, userId,
 *     domain }`; `run.ts` refuses to resume a thread whose owner is not the caller's system + user.
 *   - BUDGET (review M2): every agent VISIT costs one step in `plan_<id>` (plus one per tool round
 *     and per supervisor decision), so an unguarded handoff cycle between tool-less agents ends at
 *     the step budget, not at the recursion limit after ~1000 model calls; such a cycle is also a
 *     compile warning.
 *   - OBSERVED (A3): every node body runs inside `observed(name, body)`, which opens a Langfuse span
 *     under the run trace (`deps.observe`, see `observe.ts`), hands the body an `LlmCall` that
 *     records each completion as a generation (with the `observe` context the LiteLLM caller
 *     forwards to the gateway) and a `tool()` wrapper that records each governed call with its
 *     decision. A parked node ends its span as `parked`, a thrown one as an error. No observer →
 *     the no-op port; the graph shape is identical either way.
 */
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isGraphBubbleUp,
  type BaseCheckpointSaver,
  type CompiledStateGraph,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { IR, IRNode } from '@tabs/agents/lib/langgraph-compile';
import {
  actSystem,
  budgetMessages,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_REPEATED_CALLS,
  dedupNote,
  errorStreakNote,
  planPrompt,
  reactCall,
  toOpenAiTools,
  ToolCallingUnsupportedError,
  toolCallSignature,
  CAP_NOTE,
  CAP_SYNTHESIS_PROMPT,
  type AgenticResult,
  type AgenticStep,
  type LlmMessage,
  type ToolCall,
  type ToolSpec,
} from '@core/runtime/agentic';
import { stripThinking } from '@tabs/agents/lib/agent-chat-response';
import {
  boundInput,
  curatePredecessor,
  handoffBlock,
  nodeStatus,
  nodeSystem,
  renderUserTurn,
  resolveNodeModel,
  type AgenticGraphDeps,
  type HandoffEntry,
  type NodeRun,
  type NodeStatus,
} from '@tabs/agents/lib/build/agentic-graph';
import { evaluateWhen, parseWhen, whenChannels, WhenSyntaxError, type WhenAst } from '@tabs/agents/lib/engine/when';
import type { HoldDecision } from '@tabs/agents/lib/build/hold';
import type { ApprovalDecision, ApprovalPort, ApprovalState, RunOwner, RunnerSnapshot } from '@tabs/agents/lib/engine/approval-port';
import { noopObserver, type RunObserver, type SpanHandle } from '@tabs/agents/lib/engine/observe';
import type { LlmCall } from '@core/runtime/agentic';

// ------------------------------------------------------------------- types --

/** What the graph needs from its host — the walker's deps minus the live hooks (events flow through the stream writer). */
export type GraphDeps = Omit<AgenticGraphDeps, 'onNodeStart' | 'onStep' | 'onNodeComplete' | 'tieBreaker'> & {
  /** Checkpoint store (Postgres in the cluster, memory in tests). Absent → no checkpointing. */
  checkpointer?: BaseCheckpointSaver;
  /** Legacy grant names that resolve to no governed MCP tool — a compile error naming them. */
  unmappedTools?: string[];
  /**
   * A2 — the HOLD: how `tools_<id>` decides which calls need a human, and where it parks them.
   * Absent → nothing is held by the node (the executor may still hold with `holdAt: 'executor'`).
   */
  hold?: HoldDeps;
  /**
   * A3 — the run's Langfuse observer (trace id = run id): every node becomes a span, every model
   * call a generation, every tool call a span carrying the decision. Absent → the no-op observer.
   */
  observe?: RunObserver;
};

/** What the tools node needs to hold a call: the rule, the queue port and the attribution. */
export type HoldDeps = {
  /** The pure rule — `holdDecisionFor(preset, tool)` bound to the system's preset. */
  decide: (tool: string) => HoldDecision;
  approvals: ApprovalPort;
  systemId: string;
  domain: string;
  /** The runner's principal snapshot stored on the approval. */
  runner: RunnerSnapshot;
  /** The system principal (`os-<systemId>`) for attribution. */
  agent: string;
};

/** A held write and how it was decided (recorded once the batch executes). */
export type HeldCall = { node: string; tool: string; callId: string; approvalId: string; decision: ApprovalDecision };

/** The value `interrupt()` parks with — what the inbox card and the SSE `approval-required` event carry. */
export type InterruptPayload = { approvalId: string; tool: string; node: string; args: Record<string, unknown> };

export function isInterruptPayload(v: unknown): v is InterruptPayload {
  return !!v && typeof v === 'object' && typeof (v as InterruptPayload).approvalId === 'string' && typeof (v as InterruptPayload).tool === 'string';
}

/** The decision the node is waiting on, if the resume payload carries it (`{ [approvalId]: decision }`). */
function decisionFromResume(v: unknown, approvalId: string): ApprovalDecision | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const d = (v as Record<string, unknown>)[approvalId];
  return d === 'approve' || d === 'reject' ? d : undefined;
}

/** Model-readable typed result for a call a human REJECTED (mirrors os-tools `errorResult`). */
function rejectedResult(tool: string, approvalId: string): { text: string; isError: boolean } {
  return {
    text: JSON.stringify({ error: { code: 'rejected', reason: `${tool} was rejected in Governance — do not retry it; continue without it`, approvalId } }),
    isError: true,
  };
}

/** One supervisor routing decision, kept for the drill-down. */
export type RouteDecision = {
  supervisor: string;
  /** The agent id chosen, or 'END'. */
  next: string;
  brief: string;
  /** How the decision was obtained: the `route` tool, the `NEXT:` text fallback, a true handoff guard, or a fallback to END. */
  source: 'tool' | 'text' | 'handoff' | 'fallback';
};

export type RunBudget = { stepsUsed: number; exhausted: boolean };

/** A previously executed (tool, args) signature and its outcome — the dedup ledger of one agent visit. */
type ExecutedSig = { sig: string; count: number; ok: boolean };

/** The agent visit in flight: everything `act_<id>` / `tools_<id>` need between supersteps. */
export type AgentCursor = {
  node: string;
  plan: string;
  system: string;
  input: string;
  model: string;
  tier: 'fast' | 'reasoning';
  tierReason: string;
  /** The ACT working transcript (system + user turns + assistant tool calls + tool results). */
  messages: LlmMessage[];
  steps: AgenticStep[];
  executed: ExecutedSig[];
  iterations: number;
  maxIterations: number;
  react: boolean;
  pending: ToolCall[];
  /** A2: set once the batch's hold decisions are all known (phase 1 done); cleared when the batch is executed. */
  gate?: { decisions: Record<string, { approvalId: string; decision: ApprovalDecision }> };
  finalText: string;
  forcedStop: boolean;
  repeatedCalls: number;
  errorStreakTool: string;
  errorStreak: number;
};

/** The events nodes emit through the custom stream writer — the run route forwards them as SSE unchanged. */
export type EngineEvent =
  | { event: 'node-started'; data: { node: string; index: number; total: number } }
  | { event: 'tool-step'; data: { node: string; step: AgenticStep; index: number } }
  | { event: 'node-completed'; data: { node: string; status: NodeStatus; finalText: string } };

export class GraphCompileError extends Error {
  constructor(message: string) {
    super(`buildGraph: ${message}`);
    this.name = 'GraphCompileError';
  }
}

// ------------------------------------------------------------------- state --

const appendReducer = <T>(a: T[], b: T[] | T): T[] => a.concat(Array.isArray(b) ? b : [b]);
const lastValue = <T>(initial: () => T) => ({ reducer: (_a: T, b: T) => b, default: initial });

const FIXED = {
  messages: Annotation<LlmMessage[], LlmMessage[] | LlmMessage>({ reducer: appendReducer, default: () => [] }),
  task: Annotation<string>(lastValue(() => '')),
  current: Annotation<AgentCursor | null>(lastValue<AgentCursor | null>(() => null)),
  handoffs: Annotation<HandoffEntry[], HandoffEntry[] | HandoffEntry>({ reducer: appendReducer, default: () => [] }),
  nodeRuns: Annotation<NodeRun[], NodeRun[] | NodeRun>({ reducer: appendReducer, default: () => [] }),
  routes: Annotation<RouteDecision[], RouteDecision[] | RouteDecision>({ reducer: appendReducer, default: () => [] }),
  budget: Annotation<RunBudget>(lastValue<RunBudget>(() => ({ stepsUsed: 0, exhausted: false }))),
  held: Annotation<HeldCall[], HeldCall[] | HeldCall>({ reducer: appendReducer, default: () => [] }),
  final: Annotation<string>(lastValue(() => '')),
  failed: Annotation<string | null>(lastValue<string | null>(() => null)),
  routeNext: Annotation<string>(lastValue(() => '')),
  owner: Annotation<RunOwner | null>(lastValue<RunOwner | null>(() => null)),
};
const FIXED_ROOT = Annotation.Root(FIXED);

/** The engine's state (system channels ride alongside as extra keys — read them via `channelValues`). */
export type EngineState = typeof FIXED_ROOT.State;
export type EngineUpdate = typeof FIXED_ROOT.Update;

/** Engine-owned keys a system channel may not shadow (`messages` IS the shared channel, so it is allowed). */
export const RESERVED_STATE_KEYS: readonly string[] = Object.keys(FIXED).filter((k) => k !== 'messages');

type NodeNames = { plan: string; act: string; tools: string; route: string };

/** The compiled graph as callers see it: dynamic node names, the engine's state and update types. */
export type CompiledEngineGraph = CompiledStateGraph<EngineState, Partial<EngineUpdate>, string>;

/** Sanitise an agent id to a valid LangGraph node name fragment. */
export function safeNodeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

export type BuiltGraph = {
  graph: CompiledEngineGraph;
  /** Compile warnings — surfaced in Build and the run report, never swallowed. */
  warnings: string[];
  /** The team step budget the graph stops at (tool rounds + supervisor decisions). */
  stepBudget: number;
  /** `recursionLimit` to pass to `stream`/`invoke` — derived from `stepBudget`. */
  recursionLimit: number;
  /** Active (non-disabled) agent ids. */
  agents: string[];
  /** The LangGraph node names of one agent. */
  names: (agentId: string) => NodeNames;
};

/**
 * Every simple cycle of UNGUARDED handoffs (`when` absent), as node-id paths closing on their
 * start — such a cycle is bounded only by the step budget, so the builder warns about it.
 */
function unguardedCycles(handoffsFrom: Map<string, { to: string; when: unknown }[]>): string[][] {
  const adj = new Map<string, string[]>();
  for (const [from, list] of handoffsFrom) adj.set(from, list.filter((h) => h.when === null).map((h) => h.to));
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string, stack: string[]) => {
    const at = stack.indexOf(node);
    if (at >= 0) {
      const cyc = [...stack.slice(at), node];
      const key = [...cyc].sort().join('|');
      if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      return;
    }
    for (const next of adj.get(node) ?? []) visit(next, [...stack, node]);
  };
  for (const start of adj.keys()) visit(start, []);
  return cycles;
}

/**
 * Supersteps per budget step. One agent visit with k tool rounds is 1 (plan) + (k+1) acts +
 * k tools + 1 route = 2k+3 supersteps for k budget steps; a supervisor decision is 1 step for
 * 1 superstep; a tool-less visit costs 3 supersteps for 0 steps (bounded by the supervisor
 * decisions that re-enter it). Four per step plus a constant head is a safe ceiling — the
 * budget check in `plan_<id>`/`route_<sup>` is what ends a run gracefully, the recursion limit
 * is the hard backstop.
 */
export function recursionLimitFor(stepBudget: number): number {
  return stepBudget * 4 + 8;
}

/** The step budget a graph runs under: the team cap, else per-visit cap × agents. */
function stepBudgetFor(deps: GraphDeps, agents: number): number {
  if (deps.maxRunSteps != null && deps.maxRunSteps > 0) return deps.maxRunSteps;
  return Math.max(1, (deps.maxIterations ?? DEFAULT_MAX_ITERATIONS) * Math.max(1, agents));
}

const ROUTE_TOOL_NAME = 'route';

function routeTool(members: string[]): ToolSpec {
  return {
    name: ROUTE_TOOL_NAME,
    description:
      'Decide which team member works next, or END to finish the run. You MUST call this tool exactly once. ' +
      'Pass a short brief for the chosen member; when you choose END, the brief is the team\'s final answer to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        next: { type: 'string', enum: [...members, 'END'], description: 'The member to run next, or END.' },
        brief: { type: 'string', description: 'What the chosen member should do — or, for END, the final summary.' },
      },
      required: ['next'],
    },
  };
}

function routeInstructions(members: string[], react: boolean): string {
  const lines = [
    '',
    '--- ROUTING ---',
    `You supervise these members: ${members.join(', ')}. Read "TEAM PROGRESS SO FAR" (if any) and decide who works`,
    'next. Choose END when the task is complete; then your brief is the final answer to the user.',
  ];
  if (react) {
    lines.push('Reply with exactly one line `NEXT: <member>` (or `NEXT: END`), optionally followed by a brief.');
  } else {
    lines.push(`Call the \`${ROUTE_TOOL_NAME}\` tool exactly once with your decision.`);
  }
  return lines.join('\n');
}

const NEXT_LINE = /^\s*NEXT:\s*([A-Za-z0-9_.:-]+)\s*$/im;

/** Model-readable typed error for a call outside this node's advertised tools (mirrors os-tools `errorResult`). */
function notAdvertisedResult(agentId: string, tool: string): { text: string; isError: boolean } {
  return {
    text: JSON.stringify({ error: { code: 'not_found', reason: `Tool not available to agent '${agentId}': ${tool || '(none)'} is not in this agent's tools` } }),
    isError: true,
  };
}

/** The conversation turns (user/assistant) the agents are grounded in — never tool/system turns. */
function conversation(messages: LlmMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

function emit(config: LangGraphRunnableConfig, ev: EngineEvent): void {
  config.writer?.(ev);
}

// --------------------------------------------------------------- the build --

type NodeFn = (state: EngineState, config: LangGraphRunnableConfig) => Promise<Partial<EngineUpdate> | Command>;
/** A node body as written below: it receives the span it runs under (A3) and reports through it. */
type NodeBody = (state: EngineState, config: LangGraphRunnableConfig, obs: SpanHandle) => Promise<Partial<EngineUpdate> | Command>;

/** What a node's span records as its output — structure only, never model text. */
function summarizeUpdate(out: Partial<EngineUpdate> | Command): Record<string, unknown> {
  const u = ((out instanceof Command ? out.update : out) ?? {}) as Record<string, unknown>;
  const cur = u.current as AgentCursor | null | undefined;
  const o: Record<string, unknown> = {};
  if (out instanceof Command && typeof out.goto === 'string') o.goto = out.goto;
  if (cur && Array.isArray(cur.pending)) o.pending = cur.pending.length;
  if (cur && typeof cur.finalText === 'string' && cur.finalText) o.finalChars = cur.finalText.length;
  if (u.routeNext) o.routeNext = u.routeNext;
  if (u.routes) o.routes = u.routes;
  if (u.budget) o.budget = u.budget;
  if (u.failed) o.failed = u.failed;
  const runs = Array.isArray(u.nodeRuns) ? (u.nodeRuns as NodeRun[]) : u.nodeRuns ? [u.nodeRuns as NodeRun] : [];
  if (runs.length > 0) o.recorded = runs.map((r) => ({ node: r.node, status: r.status, steps: r.result.steps.length }));
  return o;
}

/**
 * Build the compiled StateGraph for one IR. Throws {@link GraphCompileError} for an unmapped
 * legacy tool, a malformed `when`, a channel shadowing an engine key, a disabled entrypoint or
 * colliding sanitised node names. Returns compile WARNINGS (never throws) for guards over
 * channels nothing sets.
 */
export function buildGraph(ir: IR, deps: GraphDeps): BuiltGraph {
  const warnings: string[] = [];
  const observer: RunObserver = deps.observe ?? noopObserver('unobserved');
  /** A3: run a node body under its own span; the span ends with the node (parked / failed / ok). */
  const observed = (name: string, agentId: string, kind: 'plan' | 'act' | 'tools' | 'route', body: NodeBody): NodeFn =>
    async (state, config) => {
      const span = observer.span(name, { agent: agentId, kind, visit: state.nodeRuns.length + 1, stepsUsed: state.budget.stepsUsed });
      try {
        const out = await body(state, config, span);
        span.end({ output: summarizeUpdate(out) });
        return out;
      } catch (e) {
        if (isGraphBubbleUp(e)) span.end({ parked: true });
        else span.end({ error: (e as Error)?.message ?? String(e) });
        throw e;
      }
    };
  if (deps.unmappedTools && deps.unmappedTools.length > 0) {
    throw new GraphCompileError(`unmapped legacy tool grant(s) with no governed MCP tool: ${deps.unmappedTools.join(', ')}`);
  }

  // Disabled agents are pruned at build: they never run and nothing routes to them.
  const disabled = new Set(deps.disabled ?? []);
  const active = ir.nodes.filter((n) => !disabled.has(n.id));
  if (active.length === 0) throw new GraphCompileError('every agent is disabled — nothing to run');
  if (disabled.has(ir.entrypoint)) throw new GraphCompileError(`entrypoint '${ir.entrypoint}' is disabled`);
  const byId = new Map(active.map((n) => [n.id, n]));

  // Node names: sanitised, collision-checked.
  const names = new Map<string, NodeNames>();
  const taken = new Set<string>();
  for (const n of active) {
    const safe = safeNodeName(n.id);
    const nn: NodeNames = { plan: `plan_${safe}`, act: `act_${safe}`, tools: `tools_${safe}`, route: `route_${safe}` };
    for (const v of Object.values(nn)) {
      if (taken.has(v)) throw new GraphCompileError(`agent id '${n.id}' sanitises to a node name already in use (${v})`);
      taken.add(v);
    }
    names.set(n.id, nn);
  }
  const nameOf = (id: string): NodeNames => names.get(id)!;

  // System channels → state keys with the declared reducer.
  const channelNames = Object.keys(ir.channels);
  for (const c of channelNames) {
    if (RESERVED_STATE_KEYS.includes(c)) throw new GraphCompileError(`state channel '${c}' shadows an engine state key (reserved: ${RESERVED_STATE_KEYS.join(', ')})`);
  }
  const dynamic: Record<string, unknown> = {};
  for (const [c, reducer] of Object.entries(ir.channels)) {
    if (c === 'messages') continue; // the shared conversation IS the fixed append channel
    dynamic[c] = reducer === 'add_messages'
      ? Annotation<unknown[], unknown[] | unknown>({ reducer: appendReducer, default: () => [] })
      : Annotation<unknown>(lastValue<unknown>(() => undefined));
  }
  const Root = Annotation.Root({ ...FIXED, ...dynamic }) as typeof FIXED_ROOT;
  const channelValues = (state: EngineState): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const c of channelNames) out[c] = (state as unknown as Record<string, unknown>)[c];
    return out;
  };

  // Handoffs (declared order) with parsed guards; targets pruned to active agents.
  type Handoff = { to: string; when: WhenAst | null; raw: string | null };
  const handoffsFrom = new Map<string, Handoff[]>();
  for (const c of ir.commands) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    let ast: WhenAst | null = null;
    if (c.when && c.when.trim().length > 0) {
      try {
        ast = parseWhen(c.when);
      } catch (e) {
        if (e instanceof WhenSyntaxError) throw new GraphCompileError(`handoff ${c.from} → ${c.to}: ${e.message}`);
        throw e;
      }
      for (const ch of whenChannels(ast)) {
        if (!channelNames.includes(ch)) {
          warnings.push(`handoff ${c.from} → ${c.to}: when "${c.when}" reads channel '${ch}', which is not declared in state.channels and no node sets it — the guard evaluates false`);
        } else {
          // A1: no node writes a system channel yet (messages aside), so a declared channel is never set either.
          warnings.push(`handoff ${c.from} → ${c.to}: when "${c.when}" reads channel '${ch}', which no node sets — the guard evaluates false until a node writes it`);
        }
      }
    }
    const list = handoffsFrom.get(c.from) ?? [];
    list.push({ to: c.to, when: ast, raw: c.when });
    handoffsFrom.set(c.from, list);
  }

  // An UNGUARDED handoff cycle is bounded only by the step budget — say so (review M2).
  for (const cycle of unguardedCycles(handoffsFrom)) {
    warnings.push(`handoff cycle without a guard: ${cycle.join(' → ')} — it ends only at the team step budget (one step per agent visit)`);
  }

  // Supervision: active members per supervisor; the supervisor each member returns to.
  const membersOf = new Map<string, string[]>();
  const memberOf = new Map<string, string>();
  for (const n of active) {
    if (!n.supervisor) continue;
    membersOf.set(n.id, n.members.filter((m) => byId.has(m)));
  }
  for (const e of ir.memberEdges) {
    if (byId.has(e.from) && byId.has(e.to) && membersOf.has(e.to)) memberOf.set(e.from, e.to);
  }

  const stepBudget = stepBudgetFor(deps, active.length);
  const total = active.length;

  const perVisitCap = (stepsUsed: number): number => {
    const remaining = stepBudget - stepsUsed;
    return Math.max(1, Math.min(deps.maxIterations ?? remaining, remaining));
  };

  /** A node that THREW becomes a failed visit (the walker's node-level failure surface). */
  const failedVisit = (
    config: LangGraphRunnableConfig,
    node: IRNode,
    input: string,
    e: unknown,
  ): { run: NodeRun; finalText: string; error: string } => {
    const error = (e as Error)?.message ?? String(e);
    const finalText = `(${node.id} failed: ${error})`;
    const routed = resolveNodeModel(node, deps);
    const run: NodeRun = {
      node: node.id,
      model: routed.model,
      tier: routed.tier,
      tierReason: routed.reason,
      status: 'failed',
      error,
      input,
      result: { plan: '', steps: [], finalText, iterations: 0, toolCallingSupported: true },
    };
    emit(config, { event: 'node-completed', data: { node: node.id, status: 'failed', finalText } });
    return { run, finalText, error };
  };

  /** Record the failure and stop the run. */
  const failNode = (config: LangGraphRunnableConfig, node: IRNode, input: string, e: unknown): Command => {
    const f = failedVisit(config, node, input, e);
    return new Command({ goto: END, update: { nodeRuns: [f.run], final: f.finalText, failed: f.error, current: null } });
  };

  const entries: [string, NodeFn, { ends?: string[] }?][] = [];

  for (const node of active) {
    const id = node.id;
    const nn = nameOf(id);
    const handoffs = handoffsFrom.get(id) ?? [];
    const parent = memberOf.get(id);
    const members = membersOf.get(id) ?? [];

    // ---------------------------------------------------------------- plan --
    const plan: NodeBody = async (state, config, obs) => {
      const llm = obs.llm(deps.llm, `llm.plan_${id}`);
      const stepsUsed = state.budget.stepsUsed;
      if (stepsUsed >= stepBudget) {
        return new Command({ goto: END, update: { budget: { stepsUsed, exhausted: true }, current: null } });
      }
      const turns = conversation(state.messages);
      const userTask = turns.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const transcript = await curatePredecessor(state.handoffs, node, userTask, deps);
      const system = nodeSystem(deps.preamble, node, transcript, deps.budget);
      const input = boundInput(system + renderUserTurn(turns));
      const visit = state.nodeRuns.length + 1;
      // `total` never reads below `index` on a supervisor revisit (review L2).
      emit(config, { event: 'node-started', data: { node: id, index: visit, total: Math.max(total, visit) } });
      try {
        const routed = resolveNodeModel(node, deps);
        const completion = await llm({
          model: deps.reasoningModel,
          messages: budgetMessages([{ role: 'system', content: planPrompt(system) }, ...turns], deps.budget ?? 24_000),
          temperature: 0.2,
          maxTokens: deps.maxOutputTokens,
        });
        const planText = stripThinking(completion.content) || '(no plan produced)';
        const tools = deps.toolSpecsFor(node);
        const cursor: AgentCursor = {
          node: id,
          plan: planText,
          system,
          input,
          model: routed.model,
          tier: routed.tier,
          tierReason: routed.reason,
          messages: [{ role: 'system', content: actSystem(system, planText, tools, false) }, ...turns],
          steps: [],
          executed: [],
          iterations: 0,
          maxIterations: perVisitCap(stepsUsed + 1),
          react: false,
          pending: [],
          finalText: '',
          forcedStop: false,
          repeatedCalls: 0,
          errorStreakTool: '',
          errorStreak: 0,
        };
        // One step per agent VISIT (review M2) — a tool-less handoff cycle must spend the budget.
        return new Command({ goto: nn.act, update: { current: cursor, budget: { stepsUsed: stepsUsed + 1, exhausted: false } } });
      } catch (e) {
        if (isGraphBubbleUp(e)) throw e;
        return failNode(config, node, input, e);
      }
    };

    // ----------------------------------------------------------------- act --
    const act: NodeBody = async (state, config, obs) => {
      const llm = obs.llm(deps.llm, `llm.act_${id}`);
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`act_${id}: no agent visit in flight`);
      const tools = deps.toolSpecsFor(node);
      const budget = deps.budget ?? 24_000;
      try {
        // Cap reached (or a loop guard fired): ONE final no-tools synthesis, then the soft cap note.
        if (cur.iterations >= cur.maxIterations || cur.forcedStop) {
          let finalText = '';
          try {
            const synth = await llm({
              model: cur.model,
              messages: budgetMessages([...cur.messages, { role: 'user', content: CAP_SYNTHESIS_PROMPT }], budget),
              temperature: 0.2,
              maxTokens: deps.maxOutputTokens,
            });
            finalText = stripThinking(synth.content);
          } catch (e) {
            if (isGraphBubbleUp(e)) throw e;
          }
          finalText = finalText
            ? `${finalText}${CAP_NOTE}`
            : `Reached the tool step limit (cap) before finishing — review the steps above and continue if needed.${CAP_NOTE}`;
          return { current: { ...cur, finalText, pending: [] } };
        }

        let react = cur.react;
        let messages = cur.messages;
        const wire = toOpenAiTools(tools);
        let completion;
        try {
          completion = await llm({
            model: cur.model,
            messages: budgetMessages(messages, budget),
            tools: react ? undefined : wire,
            temperature: 0.2,
            maxTokens: deps.maxOutputTokens,
          });
        } catch (e) {
          if (react || !(e instanceof ToolCallingUnsupportedError)) throw e;
          // Native tool-calling unsupported → ReAct protocol: rebuild the system prompt, retry without `tools`.
          react = true;
          messages = [{ role: 'system', content: actSystem(cur.system, cur.plan, tools, true) }, ...conversation(state.messages)];
          completion = await llm({ model: cur.model, messages: budgetMessages(messages, budget), temperature: 0.2, maxTokens: deps.maxOutputTokens });
        }
        const calls: ToolCall[] = !react && completion.toolCalls.length > 0 ? completion.toolCalls : reactCall(completion.content);
        if (calls.length === 0) {
          return { current: { ...cur, react, messages, finalText: stripThinking(completion.content), pending: [] } };
        }
        const assistant: LlmMessage = react
          ? { role: 'assistant', content: completion.content }
          : {
              role: 'assistant',
              content: completion.content,
              tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            };
        return {
          current: { ...cur, react, messages: [...messages, assistant], iterations: cur.iterations + 1, pending: calls, gate: undefined },
          budget: { stepsUsed: state.budget.stepsUsed + 1, exhausted: false },
        };
      } catch (e) {
        if (isGraphBubbleUp(e)) throw e;
        return failNode(config, node, cur.input, e);
      }
    };

    // --------------------------------------------------------------- tools --
    /**
     * Two phases, both idempotent under LangGraph's re-run-from-start on resume:
     *   1. GATE (no `cur.gate` yet): compute the hold decision for EVERY pending call, enqueue each
     *      held call once, then wait for each decision — a decided approval is read back from the
     *      queue; a pending one parks the run on `interrupt()`. Nothing executes in this phase.
     *   2. EXECUTE one call per superstep (checkpointed before the next): the node-level gate, the
     *      dedup ledger, a rejected call's typed result, else the governed executor AS THE RUNNER.
     */
    const toolsNode: NodeBody = async (state, config, obs) => {
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`tools_${id}: no agent visit in flight`);
      // THE NODE-LEVEL GATE: only the tools THIS node is advertised may reach the executor.
      const advertised = new Set(deps.toolSpecsFor(node).map((t) => t.name));

      if (!cur.gate) {
        const decisions: Record<string, { approvalId: string; decision: ApprovalDecision }> = {};
        const hold = deps.hold;
        if (hold) {
          const threadId = String(config.configurable?.thread_id ?? '');
          const heldCalls = cur.pending
            .filter((c) => advertised.has(c.name))
            .map((call) => ({ call, rule: hold.decide(call.name) }))
            .filter((h): h is { call: ToolCall; rule: { held: true; approverRole: 'domain_admin' | 'admin' } } => h.rule.held);
          const enqueue = (h: { call: ToolCall; rule: { held: true; approverRole: 'domain_admin' | 'admin' } }) =>
            hold.approvals.enqueueOnce({
              interruptKey: `${threadId}:${h.call.id}`,
              runId: threadId,
              threadId,
              systemId: hold.systemId,
              node: id,
              tool: h.call.name,
              args: h.call.args,
              approverRole: h.rule.approverRole,
              domain: hold.domain,
              runner: hold.runner,
              agent: hold.agent,
            });
          // 1a. Enqueue the WHOLE batch first so every held call is visible in the inbox at once.
          const parked: { call: ToolCall; approvalId: string; status: ApprovalState }[] = [];
          for (const h of heldCalls) {
            const r = await enqueue(h);
            parked.push({ call: h.call, approvalId: r.approvalId, status: r.status });
          }
          // 1b. Wait for each decision in order. The queue is the source of truth; `interrupt()` is
          //     how the run parks until it changes. A resume payload `{ [approvalId]: decision }`
          //     short-cuts the read; a payload for ANOTHER approval is ignored and the queue re-read.
          for (const h of parked) {
            let status: ApprovalState = h.status;
            if (status === 'pending') status = await hold.approvals.status(h.approvalId);
            while (status !== 'approve' && status !== 'reject') {
              if (status === 'unknown') {
                // The queue lost the record (e.g. a memory queue after a restart): file it again.
                const again = await enqueue(heldCalls.find((x) => x.call.id === h.call.id)!);
                h.approvalId = again.approvalId;
                status = again.status;
                if (status !== 'pending') continue;
              }
              const payload: InterruptPayload = { approvalId: h.approvalId, tool: h.call.name, node: id, args: h.call.args };
              // A3: the hold itself is an observation — the run parks here, and the trace says why.
              obs.toolEvent(h.call, { decision: 'held', approvalId: h.approvalId, detail: `held for ${heldCalls.find((x) => x.call.id === h.call.id)?.rule.approverRole ?? 'admin'} approval` });
              const resumed = interrupt<InterruptPayload, unknown>(payload);
              status = decisionFromResume(resumed, h.approvalId) ?? (await hold.approvals.status(h.approvalId));
            }
            decisions[h.call.id] = { approvalId: h.approvalId, decision: status };
          }
        }
        return { current: { ...cur, gate: { decisions } } };
      }

      // Phase 2 — execute exactly ONE pending call this superstep.
      const [call, ...rest] = cur.pending;
      if (!call) return { current: { ...cur, pending: [], gate: undefined } };
      const messages = [...cur.messages];
      const steps = [...cur.steps];
      const executed = cur.executed.map((e) => ({ ...e }));
      const held: HeldCall[] = [];
      let repeatedCalls = cur.repeatedCalls;
      let errorStreakTool = cur.errorStreakTool;
      let errorStreak = cur.errorStreak;
      let forcedStop = false;
      const feed = (text: string) => {
        if (cur.react) messages.push({ role: 'user', content: `Observation: ${text}` });
        else messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      };
      const record = (result: string, isError: boolean) => {
        const step: AgenticStep = { tool: call.name, args: call.args, result, isError };
        steps.push(step);
        emit(config, { event: 'tool-step', data: { node: id, step, index: steps.length } });
      };

      const sig = toolCallSignature(call.name, call.args);
      const priorIdx = executed.findIndex((e) => e.sig === sig);
      const prior = priorIdx >= 0 ? executed[priorIdx] : undefined;
      if (prior && prior.ok) {
        // Exact repeat of a SUCCESSFUL call: never re-run; answer with the short dedup note.
        repeatedCalls += 1;
        executed[priorIdx] = { ...prior, count: prior.count + 1 };
        const note = dedupNote(prior.count);
        obs.toolEvent(call, { decision: 'dedup', detail: note });
        record(note, false);
        feed(note);
      } else {
        const gate = cur.gate.decisions[call.id];
        let out: { text: string; isError: boolean };
        if (!advertised.has(call.name)) {
          out = notAdvertisedResult(id, call.name);
          obs.toolEvent(call, { decision: 'not_advertised' });
        } else if (gate && gate.decision === 'reject') {
          out = rejectedResult(call.name, gate.approvalId);
          obs.toolEvent(call, { decision: 'denied', approvalId: gate.approvalId, detail: 'rejected in Governance' });
        } else {
          // Approved or never held: the UNCHANGED governed executor, as the runner (gate 2 = handleRpc(user)).
          // A3: recorded as a span carrying the decision (`ok`, or `denied`/`error` from the result).
          out = await obs.tool(call, { decision: 'ok', approvalId: gate?.approvalId }, () => deps.callTool(call.name, call.args));
        }
        if (gate) held.push({ node: id, tool: call.name, callId: call.id, approvalId: gate.approvalId, decision: gate.decision });
        const entry: ExecutedSig = { sig, count: (prior?.count ?? 0) + 1, ok: !out.isError };
        if (priorIdx >= 0) executed[priorIdx] = entry;
        else executed.push(entry);
        record(out.text, out.isError);
        if (out.isError && call.name === errorStreakTool) {
          errorStreak += 1;
        } else {
          errorStreakTool = out.isError ? call.name : '';
          errorStreak = out.isError ? 1 : 0;
        }
        const streakBroken = errorStreak >= DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS;
        feed(streakBroken ? errorStreakNote(errorStreak, call.name) : out.text);
        if (streakBroken) forcedStop = true;
      }
      if (repeatedCalls >= DEFAULT_MAX_REPEATED_CALLS) forcedStop = true;
      const pending = forcedStop ? [] : rest;
      return {
        current: { ...cur, messages, steps, executed, repeatedCalls, errorStreakTool, errorStreak, forcedStop, pending, gate: pending.length > 0 ? cur.gate : undefined },
        held,
      };
    };

    // --------------------------------------------------------------- route --
    const route: NodeBody = async (state, config, obs) => {
      const cur = state.current;
      // A member returning to its supervisor arrives with the MEMBER's (already recorded) visit cleared.
      const ownVisit = !!cur && cur.node === id;
      const update: Partial<EngineUpdate> = {};
      const ownRuns: NodeRun[] = [];
      if (ownVisit) {
        const result: AgenticResult = {
          plan: cur.plan,
          steps: cur.steps,
          finalText: cur.finalText || '(no final answer produced)',
          iterations: cur.iterations,
          toolCallingSupported: !cur.react,
        };
        const status = nodeStatus(result);
        ownRuns.push({ node: id, model: cur.model, tier: cur.tier, tierReason: cur.tierReason, status, result, input: cur.input });
        update.nodeRuns = ownRuns;
        update.handoffs = [{ node: id, block: handoffBlock(id, result.finalText, result.steps), finalText: result.finalText, steps: result.steps }];
        update.final = result.finalText;
        update.current = null;
        emit(config, { event: 'node-completed', data: { node: id, status, finalText: result.finalText } });
      }
      const channels = channelValues(state);

      // 1. Handoffs in declared order: the first true guard moves control.
      let handoffTarget: string | null = null;
      for (const h of handoffs) {
        if (evaluateWhen(h.when, channels)) {
          handoffTarget = h.to;
          break;
        }
      }

      if (node.supervisor) {
        // 2. The supervisor DECIDES (conditional edges fan out from here).
        if (handoffTarget) {
          update.routes = [{ supervisor: id, next: handoffTarget, brief: '', source: 'handoff' }];
          update.routeNext = nameOf(handoffTarget).plan;
          return update;
        }
        const stepsUsed = state.budget.stepsUsed;
        if (stepsUsed >= stepBudget) {
          update.budget = { stepsUsed, exhausted: true };
          update.routeNext = END;
          return update;
        }
        try {
          const decision = await decideRoute(state, node, members, obs.llm(deps.llm, `llm.route_${id}`));
          update.routes = [decision];
          update.budget = { stepsUsed: stepsUsed + 1, exhausted: false };
          if (decision.next === 'END') {
            if (decision.brief.trim()) update.final = decision.brief.trim();
            update.routeNext = parent ? nameOf(parent).route : END;
          } else {
            update.routeNext = nameOf(decision.next).plan;
          }
          return update;
        } catch (e) {
          if (isGraphBubbleUp(e)) throw e;
          // The supervisor's conditional edge needs a target even on failure: record it and route END.
          const f = failedVisit(config, node, cur?.input ?? '', e);
          return { ...update, nodeRuns: [...ownRuns, f.run], final: f.finalText, failed: f.error, current: null, routeNext: END };
        }
      }

      // Leaf / member: handoff → supervisor return → END.
      if (handoffTarget) return new Command({ goto: nameOf(handoffTarget).plan, update });
      if (parent) return new Command({ goto: nameOf(parent).route, update });
      return new Command({ goto: END, update });
    };

    const planEnds = [nn.act, END];
    const routeEnds = node.supervisor
      ? undefined
      : [...new Set([...handoffs.map((h) => nameOf(h.to).plan), ...(parent ? [nameOf(parent).route] : []), END])];
    entries.push([nn.plan, observed(nn.plan, id, 'plan', plan), { ends: planEnds }]);
    entries.push([nn.act, observed(nn.act, id, 'act', act)]);
    entries.push([nn.tools, observed(nn.tools, id, 'tools', toolsNode)]);
    entries.push([nn.route, observed(nn.route, id, 'route', route), routeEnds ? { ends: routeEnds } : undefined]);
  }

  /** Ask the supervisor's model where to go next: the mandatory `route` tool, else the `NEXT:` text fallback. */
  async function decideRoute(state: EngineState, node: IRNode, members: string[], llm: LlmCall): Promise<RouteDecision> {
    const turns = conversation(state.messages);
    const routed = resolveNodeModel(node, deps);
    const base = nodeSystem(deps.preamble, node, state.handoffs, deps.budget);
    const budget = deps.budget ?? 24_000;
    const valid = new Set([...members, 'END']);
    const settle = (next: string, brief: string, source: RouteDecision['source']): RouteDecision => {
      if (valid.has(next)) return { supervisor: node.id, next, brief, source };
      return { supervisor: node.id, next: 'END', brief: `${brief}\n\n_(The supervisor named '${next}', which is not one of its members — the run ended.)_`.trim(), source: 'fallback' };
    };
    let completion;
    try {
      completion = await llm({
        model: routed.model,
        messages: budgetMessages([{ role: 'system', content: base + routeInstructions(members, false) }, ...turns], budget),
        tools: toOpenAiTools([routeTool(members)]),
        temperature: 0.2,
        maxTokens: deps.maxOutputTokens,
      });
    } catch (e) {
      if (!(e instanceof ToolCallingUnsupportedError)) throw e;
      completion = await llm({
        model: routed.model,
        messages: budgetMessages([{ role: 'system', content: base + routeInstructions(members, true) }, ...turns], budget),
        temperature: 0.2,
        maxTokens: deps.maxOutputTokens,
      });
    }
    const call = completion.toolCalls.find((c) => c.name === ROUTE_TOOL_NAME);
    if (call) {
      const next = typeof call.args.next === 'string' ? call.args.next.trim() : '';
      const brief = typeof call.args.brief === 'string' ? call.args.brief : '';
      return settle(next, brief, 'tool');
    }
    const text = stripThinking(completion.content);
    const m = NEXT_LINE.exec(text);
    if (m) return settle(m[1], text.replace(NEXT_LINE, '').trim(), 'text');
    // No decision at all: END, with whatever the model said as the brief (never a silent stall).
    return { supervisor: node.id, next: 'END', brief: text, source: 'fallback' };
  }

  // ----------------------------------------------------------- assemble --
  let builder = new StateGraph(Root).addNode(entries);
  builder = builder.addEdge(START, nameOf(ir.entrypoint).plan);
  for (const node of active) {
    const nn = nameOf(node.id);
    builder = builder.addConditionalEdges(nn.act, (s: EngineState) => (s.current && s.current.pending.length > 0 ? nn.tools : nn.route), {
      [nn.tools]: nn.tools,
      [nn.route]: nn.route,
    });
    // One executed call per superstep: more pending → tools again, else back to act.
    builder = builder.addConditionalEdges(nn.tools, (s: EngineState) => (s.current && s.current.pending.length > 0 ? nn.tools : nn.act), {
      [nn.tools]: nn.tools,
      [nn.act]: nn.act,
    });
    if (node.supervisor) {
      // IR conditionalEdges: router → members ∪ END (plus handoff targets and the parent supervisor's return).
      const targets = new Set<string>([END]);
      for (const m of membersOf.get(node.id) ?? []) targets.add(nameOf(m).plan);
      for (const h of handoffsFrom.get(node.id) ?? []) targets.add(nameOf(h.to).plan);
      const parent = memberOf.get(node.id);
      if (parent) targets.add(nameOf(parent).route);
      const pathMap: Record<string, string> = {};
      for (const t of targets) pathMap[t] = t;
      builder = builder.addConditionalEdges(nn.route, (s: EngineState) => (s.routeNext && pathMap[s.routeNext] ? s.routeNext : END), pathMap);
    }
  }

  const graph = builder.compile({ checkpointer: deps.checkpointer }) as unknown as CompiledEngineGraph;
  return {
    graph,
    warnings,
    stepBudget,
    recursionLimit: recursionLimitFor(stepBudget),
    agents: active.map((n) => n.id),
    names: nameOf,
  };
}

