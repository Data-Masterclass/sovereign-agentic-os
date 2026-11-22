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
 *     LangChain BaseMessage), every `state.channels` entry (`add_messages` → append; a declared
 *     type `boolean|number|string|json` → last-write-wins starting at that type's default;
 *     anything else, e.g. the legacy `last_value`, → an untyped `json` channel), plus the
 *     engine's own keys: `task`, `current` (the agent visit in
 *     flight), `handoffs` (append), `nodeRuns` (append), `routes` (append), `budget`, `held`
 *     (append), `final`, `failed`, `routeNext`, `holds` (merge: call → hold decision). A system channel colliding with an engine key is
 *     a compile error.
 *   - FOUR NODES PER AGENT: `plan_<id>` (reasoning tier, no tools; budget check; node-started),
 *     `act_<id>` (execution tier with the node's advertised tools; ReAct fallback on
 *     ToolCallingUnsupportedError; dedup / error-streak / cap synthesis exactly as the walker's
 *     harness), `tools_<id>` (NODE-LEVEL NARROWING GATE — only tools this node is advertised
 *     reach the governed executor; WP-26: the HOLD DECISION for each call is made ONCE in
 *     `act_<id>` and checkpointed in the `holds` channel; `tools_<id>` pauses on ONE
 *     `interrupt()` per held call (one per superstep, never in a loop, no queue I/O — the run
 *     driver turns each `__interrupt__` into a Governance card keyed `<thread>:<interruptId>`
 *     and resumes with `Command({ resume: { [interruptId]: decision } })`); only after every
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
 *     a channel nothing CAN set is a compile WARNING (returned, surfaced in Build), not a silent
 *     false.
 *   - STATE CHANNELS, AND WHO WRITES THEM (A5-review-H-2): a guard can only route if something
 *     sets the channel it reads, so the agent whose turn the guard follows is advertised ONE
 *     extra, built-in tool — `os_set_state` (`SET_STATE_TOOL_NAME`) — closed to the system's
 *     DECLARED channels and type-checked against their declarations. It is the `from` node of
 *     each guarded handoff that gets it, because the guard is evaluated in `route_<from>`
 *     immediately after that agent's turn. The tool touches no OS data (it writes the team's own
 *     state), so it never reaches `deps.callTool`, is never held for approval, and an undeclared
 *     channel or a wrong-typed value comes back as a typed `tool-step` error the model can read.
 *     The write lands in the graph's state in the same superstep, so the next `route` evaluation —
 *     and the supervisor's own "TEAM STATE" block — see it. Each writer's system prompt names the
 *     channels it may set, one sentence each, generated from the declaration.
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
 *   - OBSERVED (A3): every node body runs inside `observed(name, body)`, which opens a Langfuse
 *     chain observation under the run trace (`deps.observe`, see `core/infra/trace-port.ts`), hands
 *     the body an `LlmCall` that wraps each call in a `llm.<node>` span (whose id the LiteLLM caller
 *     forwards, so the gateway's generation nests under it) and a `tool()` wrapper that records each governed call with its
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
  budgetMessagesReport,
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
  callToolGuarded,
  isUnresolved,
  unresolvedWriteRepeat,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from '@tabs/agents/lib/engine/tool-result';
import {
  checkToolArgs,
  type ArgsVerdict,
  emptyReplyResult,
  truncatedCallResult,
  EMPTY_REPLY_PROMPT,
  MAX_ARG_REPAIR_ATTEMPTS,
  MAX_EMPTY_REPLY_NUDGES,
  MAX_TRUNCATED_CALL_RETRIES,
  MODEL_REPLY_STEP,
  TRUNCATED_ANSWER_NOTE,
  TRUNCATED_CALL_PROMPT,
} from '@tabs/agents/lib/engine/tool-args';
import { isWriteTool } from '@tabs/agents/lib/build/hold';
import { briefToolSpecs } from '@tabs/agents/lib/build/tool-brief';
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
import { evaluateWhen, isLegacyUnguardedWhen, parseWhen, whenChannels, WhenSyntaxError, type WhenAst } from '@tabs/agents/lib/engine/when';
import type { HoldDecision } from '@tabs/agents/lib/build/hold';
import type { ApprovalDecision, ApprovalPort, RunOwner, RunnerSnapshot } from '@tabs/agents/lib/engine/approval-port';
import { z } from 'zod';
import { noopObserver, type RunObserver, type SpanHandle } from '@core/infra/trace-port';
import { withRateLimitRetry, type RateLimitRetryOptions, type RateLimitWait } from '@tabs/agents/lib/engine/rate-limit';
import type { ContextTrim, LlmCall } from '@core/runtime/agentic';
import { estimateTokens } from '@core/infra/context/context-assembler';
import { isReasoningExhausted, reasoningTokensOf, ReasoningBudgetExhaustedError } from '@core/runtime/reasoning-budget';
import { catalogLimit } from '@core/models/model-limits';
import { DELEGATE_TOOL, DELEGATE_TOOL_SPEC, ESCALATE_TOOL, ESCALATE_TOOL_SPEC } from '@core/runtime/lead-tools';

// ------------------------------------------------------------------- types --

/** What the graph needs from its host — the walker's deps minus the live hooks (events flow through the stream writer). */
/**
 * Bound ONE model request to the input budget — its TOOL DEFINITIONS INCLUDED (they ride in the
 * same request, and at ~5k tokens they were the part the budget did not count) — and report a trim.
 */
function fitRequest(
  deps: Pick<GraphDeps, 'onContextTrim'>,
  node: string,
  messages: LlmMessage[],
  budget: number,
  wire?: unknown,
): LlmMessage[] {
  const toolTokens = wire ? estimateTokens(JSON.stringify(wire)) : 0;
  const { messages: fitted, trim } = budgetMessagesReport(messages, Math.max(512, budget - toolTokens));
  if (trim) deps.onContextTrim?.({ node, ...trim });
  return fitted;
}

/** The output cap for a call on `model`: that model's own limit when the deps can say, else the one shared number. */
function outMax(deps: { maxOutputTokens?: number; maxOutputTokensFor?: (model: string) => number | undefined }, model: string): number | undefined {
  return deps.maxOutputTokensFor?.(model) ?? deps.maxOutputTokens;
}

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
   * RESOURCE GRANTS, asked ahead of the hold: would the executor refuse this call because it names
   * a resource outside the system's grants? Returns the typed refusal, or null. `tools_<id>` asks
   * for the whole batch BEFORE it holds anything, so a person is never asked to approve a call
   * that would be refused anyway. The executor makes the same check again when it runs a call —
   * this is an early answer, never the enforcement. Absent → nothing is refused here.
   */
  precheck?: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | null>;
  /**
   * A3 — the run's Langfuse observer (trace id = run id): every node becomes a span, every model
   * call a generation, every tool call a span carrying the decision. Absent → the no-op observer.
   */
  observe?: RunObserver;
  /**
   * X9 — the engine's own guardrail on EVERY tool result: a result longer than this is truncated
   * before it enters the prompt, with a visible marker and the real row count
   * (`AGENT_TOOL_RESULT_MAX_CHARS`). Default {@link DEFAULT_TOOL_RESULT_MAX_CHARS}.
   */
  toolResultMaxChars?: number;
  /**
   * Track B — told when a request's history had to be trimmed to fit the model's input budget
   * (the model itself is told by the note `budgetMessagesReport` adds). The run collects these
   * into its warnings. Absent → the trim is still told to the model, just not collected.
   */
  onContextTrim?: (ev: ContextTrim & { node: string }) => void;
  /**
   * X9 — per-tool-call deadline (`AGENT_TOOL_CALL_TIMEOUT_MS`). A tool that does not answer in
   * time becomes a typed `timeout` tool result, so the superstep ends instead of hanging.
   * Default {@link DEFAULT_TOOL_CALL_TIMEOUT_MS}.
   */
  toolCallTimeoutMs?: number;
  /**
   * How a tool call's arguments are checked before it may run. Absent → {@link checkToolArgs}:
   * the argument text must be a JSON object AND satisfy the tool's input schema. Production never
   * sets this. It exists for the frozen parity goldens, whose scripted model calls every tool
   * with fixture arguments (`{ input, task }`) that satisfy no real schema — those replay with
   * {@link checkToolArgsJsonOnly}, which still refuses a call whose JSON was broken.
   */
  checkArgs?: (call: ToolCall, spec: ToolSpec) => ArgsVerdict;
  /**
   * How a model RATE LIMIT (a LiteLLM 429 on requests/tokens per minute) is waited out: bounded
   * retries, a capped wait, an injectable clock for tests. Absent → the defaults in
   * `rate-limit.ts` (3 retries, 75 s cap). `{ retries: 0 }` turns the waiting off. A spent BUDGET
   * is never retried, whatever this says.
   */
  rateLimit?: Pick<RateLimitRetryOptions, 'retries' | 'maxWaitMs' | 'now' | 'sleep' | 'jitter'>;
};

/**
 * The hold. The GRAPH reads only `decide`, once per tool call, in `act_<id>` (the result is
 * checkpointed in `state.holds`). The rest is OS wrapper data for the run driver (`run.ts`), which
 * turns each LangGraph `__interrupt__` into ONE Governance card — the graph never touches the queue.
 */
export type HoldDeps = {
  /** The pure rule — `holdDecisionFor(preset, tool)` bound to the system's preset. */
  decide: (tool: string) => HoldDecision;
  /** Read by `run.ts` only: where an interrupt becomes a card, keyed `<thread>:<interruptId>`. */
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

/**
 * The hold decision for ONE tool call, made ONCE in `act_<id>` and checkpointed in the `holds`
 * channel before any interrupt. `tools_<id>` reads only this — it never re-asks the rule — so a
 * policy change between pause and resume cannot turn a held or rejected call into an executed one
 * (LangGraph re-runs the paused node from its start on resume). `refused` = the resource grants
 * refuse the call (the typed text); it is never held and never executed.
 */
export type HoldEntry = { held: boolean; approverRole?: 'domain_admin' | 'admin'; refused?: string; reason: string };

/** A call with no `holds` entry while a hold rule is configured: held, for an admin (fail closed). */
const FAIL_CLOSED_HOLD: HoldEntry = { held: true, approverRole: 'admin', reason: 'no hold decision on record for this call (held for an admin)' };

/** The `holds` key: unique per agent visit, ACT round and call id (model call ids repeat across visits). */
export function holdKey(node: string, visit: number, round: number, callId: string): string {
  return `${node}#${visit}.${round}:${callId}`;
}

/** Upper bound (chars) on the tool arguments a paused call carries in its interrupt value. */
const HOLD_ARGS_MAX = 4_000;
function boundedHoldArgs(args: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(args ?? {});
  return text.length <= HOLD_ARGS_MAX ? args : { _truncated: true, preview: `${text.slice(0, HOLD_ARGS_MAX)}…` };
}

/**
 * The value `interrupt()` pauses with — one per held call. The run driver (`run.ts`) turns it into
 * ONE Governance card keyed `<thread>:<interruptId>`; the SSE `approval-required` event carries it.
 */
export type HoldInterrupt = {
  kind: 'os.hold';
  tool: string;
  node: string;
  callId: string;
  args: Record<string, unknown>;
  approverRole: 'domain_admin' | 'admin';
  reason: string;
};

export function isHoldInterrupt(v: unknown): v is HoldInterrupt {
  return !!v && typeof v === 'object' && (v as HoldInterrupt).kind === 'os.hold' && typeof (v as HoldInterrupt).tool === 'string';
}

/**
 * ONE-RELEASE SHIM: the value a thread parked under the previous engine carries (the card was
 * filed inside the node, so the value names its approval). Recognised so such a thread can still
 * be resumed (`run.ts` `resolveResume`); never produced any more.
 */
export type LegacyHoldInterrupt = { approvalId: string; tool: string; node: string; args: Record<string, unknown> };

export function isLegacyHoldInterrupt(v: unknown): v is LegacyHoldInterrupt {
  return !!v && typeof v === 'object' && !('kind' in v) && typeof (v as LegacyHoldInterrupt).approvalId === 'string' && typeof (v as LegacyHoldInterrupt).tool === 'string';
}

/**
 * The resume value a paused call accepts — validated by LangGraph itself (`interrupt`'s
 * `responseSchema`), so a malformed decision is a ZodError, never a guess.
 */
export const HOLD_ANSWER = z.object({
  decision: z.enum(['approve', 'reject', 'withdraw']),
  approvalId: z.string().min(1),
});
export type HoldAnswer = z.infer<typeof HOLD_ANSWER>;

/** Model-readable typed result for a call a human REJECTED (mirrors os-tools `errorResult`). */
function rejectedResult(tool: string, approvalId: string): { text: string; isError: boolean } {
  return {
    text: JSON.stringify({ error: { code: 'rejected', reason: `${tool} was rejected in Governance — do not retry it; continue without it`, approvalId } }),
    isError: true,
  };
}

/** Model-readable typed result for a held call its own REQUESTER took back before anyone decided it. */
function withdrawnResult(tool: string, approvalId: string): { text: string; isError: boolean } {
  return {
    text: JSON.stringify({ error: { code: 'withdrawn_by_requester', reason: `${tool} was withdrawn by the person who started this run before anyone approved it — it was not executed; do not retry it; continue without it`, approvalId } }),
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
/**
 * One tool-call signature the node has already dispatched.
 *   `ok`         — it answered without an error (an exact repeat is short-circuited).
 *   `unresolved` — it did NOT answer before the deadline, so whether it took effect is unknown.
 *                  A repeat of an unresolved WRITE is refused (review M-3), never re-dispatched.
 */
type ExecutedSig = { sig: string; count: number; ok: boolean; unresolved?: boolean };

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
  /** The decisions answered so far for this batch's held calls (call id → decision); cleared when the batch is executed. */
  gate?: {
    decisions: Record<string, { approvalId: string; decision: ApprovalDecision }>;
    /** Pre-WP-26 checkpoints only: grant refusals computed in the old gate phase. */
    refused?: Record<string, string>;
  };
  finalText: string;
  forcedStop: boolean;
  repeatedCalls: number;
  errorStreakTool: string;
  errorStreak: number;
  /**
   * The last reply could not be acted on (invalid arguments with nothing else to run, a cut-off
   * tool call, an empty reply): `act_<id>` runs again with what the model was told. Optional —
   * a checkpoint written before these fields existed reads as "no".
   */
  again?: boolean;
  /** Consecutive replies that carried a tool call with invalid arguments (reset by a clean reply). */
  invalidCalls?: number;
  /** Tool calls cut off at the output limit in this visit. */
  truncatedCalls?: number;
  /** Empty replies in this visit. */
  emptyReplies?: number;
  /** The worker handed this visit to the strong model (lead switch ON): once per visit. */
  escalated?: boolean;
  /** The final answer was cut off at the output limit. */
  truncated?: boolean;
};

/** The events nodes emit through the custom stream writer — the run route forwards them as SSE unchanged. */
export type EngineEvent =
  | { event: 'node-started'; data: { node: string; index: number; total: number } }
  | { event: 'tool-step'; data: { node: string; step: AgenticStep; index: number } }
  | { event: 'node-completed'; data: { node: string; status: NodeStatus; finalText: string } }
  /** The agent is WAITING for the model rate limit to reset before re-sending its request. */
  | { event: 'rate-limit-wait'; data: { node: string } & RateLimitWait };

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
  /** Each tool call's hold decision, made ONCE in `act_<id>` (merge; see {@link HoldEntry}). */
  holds: Annotation<Record<string, HoldEntry>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
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

// ----------------------------------------------------------- state channels --

/** The declared value type of a state channel — what `os_set_state` accepts for it. */
export type ChannelType = 'boolean' | 'number' | 'string' | 'json';
const CHANNEL_TYPES: readonly string[] = ['boolean', 'number', 'string', 'json'];

/**
 * How one `state.channels: { <name>: <declaration> }` entry is read:
 *   • `add_messages` — the appending conversation reducer (a list; not settable as one value);
 *   • `boolean` | `number` | `string` | `json` — a typed, last-write-wins channel that starts at
 *     that type's default ({@link channelDefault});
 *   • anything else (the legacy `last_value`) — an untyped `json` channel, so a system.yaml
 *     written before the types existed keeps working unchanged.
 */
export function channelTypeOf(declaration: string): ChannelType | 'add_messages' {
  const d = (declaration ?? '').trim();
  if (d === 'add_messages') return 'add_messages';
  return CHANNEL_TYPES.includes(d) ? (d as ChannelType) : 'json';
}

/** The value a declared channel starts at — the declaration IS the default. */
export function channelDefault(type: ChannelType): unknown {
  return type === 'boolean' ? false : type === 'number' ? 0 : type === 'string' ? '' : null;
}

/** The built-in channel-writing tool. Not an MCP tool: it writes the team's own state, nothing else. */
export const SET_STATE_TOOL_NAME = 'os_set_state';

/** A declared channel and the type its declaration gives it. */
export type SettableChannel = [name: string, type: ChannelType];

function setStateTool(channels: SettableChannel[]): ToolSpec {
  return {
    name: SET_STATE_TOOL_NAME,
    description:
      `Record one TEAM STATE CHANNEL so the handoff guards can route on it. Channels: ${channels.map(([n, t]) => `${n} (${t})`).join(', ')}. ` +
      'Call it the moment the condition a channel names has actually become true — the guards are evaluated right after your turn, so this is how control moves. ' +
      'It writes the team\'s own state only: no OS data, no approval, no side effect outside this run.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: channels.map(([n]) => n), description: 'The declared channel to write.' },
        value: { description: 'The value to record — matching the channel\'s declared type (boolean / number / string / JSON).' },
      },
      required: ['channel', 'value'],
    },
  };
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  return `${JSON.stringify(v)}`;
}

/** Type-check one channel value, tolerating the string forms a model emits (`"true"`, `"3"`). */
function coerceChannelValue(raw: unknown, type: ChannelType): { value: unknown } | { error: string } {
  if (type === 'json') return { value: raw };
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw };
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: `got ${describeValue(raw)} — pass true or false` };
  }
  if (type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw };
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return { value: Number(raw) };
    return { error: `got ${describeValue(raw)} — pass a number` };
  }
  if (typeof raw === 'string') return { value: raw };
  return { error: `got ${describeValue(raw)} — pass a string` };
}

/**
 * Validate an `os_set_state` call against the DECLARED channels. Returns the write to apply, or
 * the reason it is refused — an undeclared channel never becomes a state key, and a wrong-typed
 * value never reaches one.
 */
export function parseStateWrite(
  args: Record<string, unknown>,
  allowed: SettableChannel[],
): { channel: string; value: unknown } | { error: string } {
  const names = allowed.map(([n]) => n).join(', ');
  const name = typeof args.channel === 'string' ? args.channel.trim() : '';
  if (!name) return { error: `${SET_STATE_TOOL_NAME} needs a 'channel' — one of: ${names}` };
  const hit = allowed.find(([n]) => n === name);
  if (!hit) return { error: `'${name}' is not a declared state channel — you may set: ${names}` };
  if (args.value === undefined) return { error: `${SET_STATE_TOOL_NAME} needs a 'value' for '${name}' (${hit[1]})` };
  const coerced = coerceChannelValue(args.value, hit[1]);
  if ('error' in coerced) return { error: `'${name}' is declared ${hit[1]}; ${coerced.error}` };
  return { channel: name, value: coerced.value };
}

/** Model-readable typed rejection for a state write the declaration does not allow. */
function badStateWrite(reason: string): { text: string; isError: boolean } {
  return { text: JSON.stringify({ error: { code: 'invalid_argument', reason } }), isError: true };
}

/** A channel this node's own guard reads: what setting it does. */
type OwnChannel = { channel: string; type: ChannelType; to: string; when: string };

/**
 * The channel block appended to a writer's system prompt: ONE sentence per channel, generated
 * from the declaration (never hand-written prose that can drift from the yaml).
 */
function stateChannelBrief(own: OwnChannel[], others: SettableChannel[]): string {
  const lines = [
    '',
    '--- STATE CHANNELS ---',
    `Record team state with the \`${SET_STATE_TOOL_NAME}\` tool. The handoff guards are evaluated right after your turn, so a channel you set now decides where control goes next. Set nothing you have not actually done.`,
  ];
  for (const o of own) lines.push(`- ${o.channel} (${o.type}): set it when control should pass to ${o.to} — the guard is \`${o.when}\`.`);
  if (others.length > 0) lines.push(`- Also declared, settable if the team needs it: ${others.map(([n, t]) => `${n} (${t})`).join(', ')}.`);
  return lines.join('\n');
}

/** What the supervisor is shown of the team's OWN state when it decides (the channels, not prose). */
function stateSnapshot(values: Record<string, unknown>, settable: SettableChannel[]): string {
  if (settable.length === 0) return '';
  return `\n\n--- TEAM STATE ---\n${settable.map(([n]) => `${n}=${JSON.stringify(values[n] ?? null)}`).join(' · ')}`;
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
  // Anything else in the update is a SYSTEM CHANNEL write — the trace should say so.
  for (const [k, v] of Object.entries(u)) if (!(k in FIXED)) o[`state.${k}`] = v;
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
  /** Every declared channel and how its declaration types it. */
  const channelTypes = new Map<string, ChannelType | 'add_messages'>();
  for (const [c, declaration] of Object.entries(ir.channels)) {
    channelTypes.set(c, c === 'messages' ? 'add_messages' : channelTypeOf(declaration));
  }
  /** The channels an agent can WRITE with `os_set_state`: declared and single-valued. */
  const settable: SettableChannel[] = [...channelTypes]
    .filter((e): e is SettableChannel => e[1] !== 'add_messages')
    .map(([n, t]) => [n, t]);
  const dynamic: Record<string, unknown> = {};
  for (const c of channelNames) {
    if (c === 'messages') continue; // the shared conversation IS the fixed append channel
    const type = channelTypes.get(c)!;
    dynamic[c] = type === 'add_messages'
      ? Annotation<unknown[], unknown[] | unknown>({ reducer: appendReducer, default: () => [] })
      : Annotation<unknown>(lastValue<unknown>(() => channelDefault(type)));
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
  /**
   * A5-review-H-2: who may write which channel. A guard is evaluated in `route_<from>`, i.e.
   * immediately after the `from` agent's turn — so that agent is the one that must be able to
   * set the channels its own guard reads, and it is the one advertised `os_set_state`.
   */
  const ownChannels = new Map<string, OwnChannel[]>();
  for (const c of ir.commands) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    let ast: WhenAst | null = null;
    // Two scaffolders used to write a LABEL into `when`: the workflow scaffold the literal
    // 'step complete' (until 2026-11-18), the team proposer '<role> complete'. Neither was ever a
    // condition — it meant "go on when this step is done", which is exactly the unguarded edge.
    // Read that shape as unguarded so stored teams run, and say so; anything else that is not an
    // expression still fails (`isLegacyUnguardedWhen` holds the exact rule).
    const legacyUnguarded = isLegacyUnguardedWhen(c.when);
    if (legacyUnguarded) {
      warnings.push(`handoff ${c.from} → ${c.to}: when "${c.when}" is a label an earlier scaffold wrote, not a condition — treated as an unconditional handoff (clear it, or write a real condition)`);
    } else if (c.when && c.when.trim().length > 0) {
      try {
        ast = parseWhen(c.when);
      } catch (e) {
        if (e instanceof WhenSyntaxError) throw new GraphCompileError(`handoff ${c.from} → ${c.to}: ${e.message}`);
        throw e;
      }
      for (const ch of whenChannels(ast)) {
        const type = channelTypes.get(ch);
        if (type === undefined) {
          warnings.push(`handoff ${c.from} → ${c.to}: when "${c.when}" reads channel '${ch}', which is not declared in state.channels — no agent can set it, so the guard evaluates false`);
        } else if (type === 'add_messages') {
          warnings.push(`handoff ${c.from} → ${c.to}: when "${c.when}" reads channel '${ch}', declared with the add_messages reducer — ${SET_STATE_TOOL_NAME} writes single values, so no agent can set it`);
        } else {
          const own = ownChannels.get(c.from) ?? [];
          if (!own.some((o) => o.channel === ch)) own.push({ channel: ch, type, to: c.to, when: c.when.trim() });
          ownChannels.set(c.from, own);
        }
      }
    }
    const list = handoffsFrom.get(c.from) ?? [];
    list.push({ to: c.to, when: ast, raw: legacyUnguarded ? null : c.when });
    handoffsFrom.set(c.from, list);
  }

  /** The node's advertised tools: its governed grants plus, for a channel writer, `os_set_state`. */
  const setter = setStateTool(settable);
  // The lead tool this run offers: delegate_to_worker when strong leads and a hook runs it, escalate_to_strong when the worker leads.
  const leadTool: ToolSpec | null = !deps.lead ? null : deps.lead.mode === 'strong' ? (deps.lead.delegate ? DELEGATE_TOOL_SPEC : null) : deps.reasoningModel !== deps.execModel ? ESCALATE_TOOL_SPEC : null;
  const workerLeads = deps.lead?.mode === 'worker' && deps.reasoningModel !== deps.execModel;
  const toolsFor = (node: IRNode): ToolSpec[] => {
    const base = deps.toolSpecsFor(node);
    const withLead = leadTool ? [...base, leadTool] : base;
    return ownChannels.has(node.id) ? [...withLead, setter] : withLead;
  };

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
    partial?: Pick<AgentCursor, 'plan' | 'steps' | 'iterations' | 'react'>,
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
      // What the agent DID before it failed stays on the record (its plan and the tool steps
      // that ran) — a failed visit is not an empty one.
      result: {
        plan: partial?.plan ?? '',
        steps: partial?.steps ?? [],
        finalText,
        iterations: partial?.iterations ?? 0,
        toolCallingSupported: partial ? !partial.react : true,
        pending: [],
      },
    };
    emit(config, { event: 'node-completed', data: { node: node.id, status: 'failed', finalText } });
    return { run, finalText, error };
  };

  /**
   * Record the failure and stop the run. `failed` is what the edges out of `act_<id>` read: a
   * `Command({ goto })` ADDS to a node's edges, it does not replace them, so without that check
   * the conditional edge still sent a failed agent on to `route_<id>` — which handed off to the
   * next agent as if the visit had succeeded.
   */
  const failNode = (
    config: LangGraphRunnableConfig,
    node: IRNode,
    input: string,
    e: unknown,
    partial?: Pick<AgentCursor, 'plan' | 'steps' | 'iterations' | 'react'>,
  ): Command => {
    const f = failedVisit(config, node, input, e, partial);
    return new Command({ goto: END, update: { nodeRuns: [f.run], final: f.finalText, failed: f.error, current: null } });
  };

  /**
   * The model caller a node uses: recorded by the span (every attempt is its own generation), and
   * a RATE-LIMIT 429 is waited out and re-sent instead of failing the node — visibly, through a
   * `rate-limit-wait` event, so a run that is waiting does not look like one that is stuck.
   */
  const modelFor = (obs: SpanHandle, config: LangGraphRunnableConfig, agentId: string, name: string): LlmCall =>
    withRateLimitRetry(obs.llm(deps.llm, name), {
      ...deps.rateLimit,
      signal: config.signal,
      onWait: (wait) => emit(config, { event: 'rate-limit-wait', data: { node: agentId, ...wait } }),
    });

  const entries: [string, NodeFn, { ends?: string[] }?][] = [];

  for (const node of active) {
    const id = node.id;
    const nn = nameOf(id);
    const handoffs = handoffsFrom.get(id) ?? [];
    const parent = memberOf.get(id);
    const members = membersOf.get(id) ?? [];
    // The channel brief, generated from the declaration (empty for an agent that writes none).
    const own = ownChannels.get(id);
    const channelBrief = own ? stateChannelBrief(own, settable.filter(([n]) => !own.some((o) => o.channel === n))) : '';

    // ---------------------------------------------------------------- plan --
    const plan: NodeBody = async (state, config, obs) => {
      const llm = modelFor(obs, config, id, `llm.plan_${id}`);
      const stepsUsed = state.budget.stepsUsed;
      if (stepsUsed >= stepBudget) {
        return new Command({ goto: END, update: { budget: { stepsUsed, exhausted: true }, current: null } });
      }
      const turns = conversation(state.messages);
      const userTask = turns.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const transcript = await curatePredecessor(state.handoffs, node, userTask, deps);
      const system = nodeSystem(deps.preamble, node, transcript, deps.budget, deps.roleOf?.(node.id)) + channelBrief;
      const input = boundInput(system + renderUserTurn(turns));
      const visit = state.nodeRuns.length + 1;
      // `total` never reads below `index` on a supervisor revisit (review L2).
      emit(config, { event: 'node-started', data: { node: id, index: visit, total: Math.max(total, visit) } });
      try {
        const routed = resolveNodeModel(node, deps);
        const completion = await llm({
          // The lead plans: the strong model by default, the worker when "Save costs" is on.
          model: workerLeads ? deps.execModel : deps.reasoningModel,
          messages: fitRequest(deps, id, [{ role: 'system', content: planPrompt(system) }, ...turns], deps.budget ?? 24_000),
          temperature: 0.2,
          maxTokens: outMax(deps, deps.reasoningModel),
          ...(deps.reasoningEfforts?.plan ? { reasoningEffort: deps.reasoningEfforts.plan } : {}),
        });
        const planText = stripThinking(completion.content) || '(no plan produced)';
        const tools = toolsFor(node);
        const cursor: AgentCursor = {
          node: id,
          plan: planText,
          system,
          input,
          model: routed.model,
          tier: routed.tier,
          tierReason: routed.reason,
          // PROMPT DIET: with native tool-calling the full descriptions travel in the request's
          // `tools` schema, so the prompt's own list is names + one-line summaries. The ReAct
          // fallback in `act_<id>` rebuilds this prompt with the FULL descriptions, because there
          // the prompt is the only place the model can read them.
          messages: [{ role: 'system', content: actSystem(system, planText, briefToolSpecs(tools), false) }, ...turns],
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
      const llm = modelFor(obs, config, id, `llm.act_${id}`);
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`act_${id}: no agent visit in flight`);
      const tools = toolsFor(node);
      const budget = deps.budget ?? 24_000;
      try {
        // Cap reached (or a loop guard fired): ONE final no-tools synthesis, then the soft cap note.
        if (cur.iterations >= cur.maxIterations || cur.forcedStop) {
          let finalText = '';
          try {
            const synth = await llm({
              model: cur.model,
              messages: fitRequest(deps, id, [...cur.messages, { role: 'user', content: CAP_SYNTHESIS_PROMPT }], budget),
              temperature: 0.2,
              maxTokens: outMax(deps, cur.model),
              ...(deps.reasoningEfforts?.final ? { reasoningEffort: deps.reasoningEfforts.final } : {}),
            });
            finalText = stripThinking(synth.content);
          } catch (e) {
            if (isGraphBubbleUp(e)) throw e;
          }
          finalText = finalText
            ? `${finalText}${CAP_NOTE}`
            : `Reached the tool step limit (cap) before finishing — review the steps above and continue if needed.${CAP_NOTE}`;
          return { current: { ...cur, finalText, pending: [], again: false } };
        }

        let react = cur.react;
        let messages = cur.messages;
        const wire = toOpenAiTools(tools);
        let completion;
        try {
          completion = await llm({
            model: cur.model,
            messages: fitRequest(deps, id, messages, budget, react ? undefined : wire),
            tools: react ? undefined : wire,
            temperature: 0.2,
            maxTokens: outMax(deps, cur.model),
            ...(deps.reasoningEfforts?.act ? { reasoningEffort: deps.reasoningEfforts.act } : {}),
          });
        } catch (e) {
          if (react || !(e instanceof ToolCallingUnsupportedError)) throw e;
          // Native tool-calling unsupported → ReAct protocol: rebuild the system prompt, retry without `tools`.
          react = true;
          messages = [{ role: 'system', content: actSystem(cur.system, cur.plan, tools, true) }, ...conversation(state.messages)];
          completion = await llm({ model: cur.model, messages: fitRequest(deps, id, messages, budget), temperature: 0.2, maxTokens: outMax(deps, cur.model), ...(deps.reasoningEfforts?.act ? { reasoningEffort: deps.reasoningEfforts.act } : {}) });
        }
        // WORKER LEADS: a refusal, an empty reply or its own `escalate_to_strong` hands the node to the strong model, once.
        const canEscalate = workerLeads && cur.model === deps.execModel && !cur.escalated;
        const escalateTo = (tool: string, reason: string, base: LlmMessage[]) => {
          const step: AgenticStep = { tool, args: { reason }, result: `Escalated to the strong model: ${reason}.`, isError: false };
          emit(config, { event: 'tool-step', data: { node: id, step, index: cur.steps.length + 1 } });
          return { current: { ...cur, react, model: deps.reasoningModel, escalated: true, steps: [...cur.steps, step], messages: base, pending: [], again: true }, budget: { stepsUsed: state.budget.stepsUsed + 1, exhausted: false } };
        };
        if (canEscalate && (completion.refusal || completion.finishReason === 'content_filter')) {
          return escalateTo(ESCALATE_TOOL, completion.refusal ? 'the worker refused' : 'the worker reply was blocked', messages);
        }
        // (c) A REFUSAL is not an answer: the agent fails, saying so, instead of handing it on.
        if (completion.refusal) throw new Error(`the model refused: ${completion.refusal}`);
        if (completion.finishReason === 'content_filter') throw new Error("the model's reply was blocked by the provider's content filter");

        const calls: ToolCall[] = !react && completion.toolCalls.length > 0 ? completion.toolCalls : reactCall(completion.content);
        const cutOff = completion.finishReason === 'length';
        const asked = calls.find((c) => c.name === ESCALATE_TOOL);
        if (asked && canEscalate) {
          const reason = typeof asked.args.reason === 'string' && asked.args.reason.trim() ? asked.args.reason.trim().slice(0, 300) : 'the worker judged the task too hard';
          const note = 'Escalated: the strong model takes over this task from here. Continue with the task.';
          const answered: LlmMessage[] = calls.map((c) => ({ role: 'tool' as const, tool_call_id: c.id, content: c.id === asked.id ? note : 'not executed: the task was escalated to the strong model; call it again if it is still needed.' }));
          const asst: LlmMessage = react
            ? { role: 'assistant', content: completion.content }
            : { role: 'assistant', content: completion.content, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
          return escalateTo(ESCALATE_TOOL, reason, react ? [...messages, asst, { role: 'user', content: `Observation: ${note}` }] : [...messages, asst, ...answered]);
        }
        const steps = [...cur.steps];
        /** A step recorded by this node itself: a call that was NOT run, or a reply that could not be used. */
        const record = (tool: string, args: Record<string, unknown>, result: string) => {
          const step: AgenticStep = { tool, args, result, isError: true };
          steps.push(step);
          emit(config, { event: 'tool-step', data: { node: id, step, index: steps.length } });
        };
        // Every retry below is a model call that produced nothing usable: it costs a step and a round.
        const spent = { stepsUsed: state.budget.stepsUsed + 1, exhausted: false };

        if (calls.length === 0) {
          const text = stripThinking(completion.content);
          if (!text && canEscalate) return escalateTo(ESCALATE_TOOL, 'the worker returned an empty answer', messages);
          if (!text) {
            // A reasoning model that spent its WHOLE output budget thinking said nothing because it ran out of room,
            // not because it chose silence: asking again with the same budget cannot help, so say exactly that.
            if (isReasoningExhausted(completion)) {
              const target = catalogLimit(cur.model)?.target ?? cur.model;
              record(MODEL_REPLY_STEP, {}, JSON.stringify({ error: { code: 'reasoning_budget_exhausted', reason: 'The model spent its whole output budget on reasoning and wrote no answer.' } }));
              return failNode(config, node, cur.input, new ReasoningBudgetExhaustedError(reasoningTokensOf(completion), cur.model, target, deps.maxOutputTokensFor?.(cur.model) ?? deps.maxOutputTokens), { ...cur, steps, react });
            }
            // (d) AN EMPTY REPLY is not "ok": one nudge, then the agent fails.
            const emptyReplies = cur.emptyReplies ?? 0;
            record(MODEL_REPLY_STEP, {}, emptyReplyResult());
            if (emptyReplies >= MAX_EMPTY_REPLY_NUDGES) {
              return failNode(config, node, cur.input, new Error(`the model returned nothing (an empty reply ${emptyReplies + 1} times, the last after being asked again)`), { ...cur, steps, react });
            }
            return {
              current: { ...cur, react, steps, messages: [...messages, { role: 'user', content: EMPTY_REPLY_PROMPT }], emptyReplies: emptyReplies + 1, iterations: cur.iterations + 1, pending: [], again: true },
              budget: spent,
            };
          }
          // (b) A FINAL ANSWER cut off at the output limit is kept, and marked as cut off.
          return { current: { ...cur, react, messages, finalText: cutOff ? `${text}${TRUNCATED_ANSWER_NOTE}` : text, truncated: cutOff || undefined, pending: [], again: false } };
        }

        if (cutOff) {
          // (b) A TOOL CALL cut off at the output limit is not executed, even when what arrived
          // happens to parse: one retry asking for a shorter call, then the agent fails.
          const truncatedCalls = cur.truncatedCalls ?? 0;
          for (const c of calls) record(c.name, c.args, truncatedCallResult(c.name));
          if (truncatedCalls >= MAX_TRUNCATED_CALL_RETRIES) {
            return failNode(
              config,
              node,
              cur.input,
              new Error(`a tool call (${calls.map((c) => c.name).join(', ')}) was cut off at the model's output limit ${truncatedCalls + 1} times — nothing was executed. Ask for smaller calls, or raise the model's output limit.`),
              { ...cur, steps, react },
            );
          }
          return {
            current: { ...cur, react, steps, messages: [...messages, { role: 'user', content: TRUNCATED_CALL_PROMPT }], truncatedCalls: truncatedCalls + 1, iterations: cur.iterations + 1, pending: [], again: true },
            budget: spent,
          };
        }

        // (a) ARGUMENTS. A call whose argument text was not a JSON object, or whose arguments fail
        // the tool's own input schema, is NOT executed and never reaches the hold: the model gets
        // a typed error naming the problem and the expected shape. A tool this node is not
        // advertised is left to `tools_<id>`, which answers it with the typed `not_found`.
        const specs = new Map(tools.map((t) => [t.name, t]));
        const runnable: ToolCall[] = [];
        const refused: { call: ToolCall; text: string; problem: string }[] = [];
        for (const c of calls) {
          const spec = specs.get(c.name);
          if (!spec) { runnable.push(c); continue; }
          const verdict = (deps.checkArgs ?? checkToolArgs)(c, spec);
          if (verdict.ok) runnable.push({ id: c.id, name: c.name, args: verdict.args });
          else refused.push({ call: c, text: verdict.text, problem: verdict.problem });
        }
        const assistant: LlmMessage = react
          ? { role: 'assistant', content: completion.content }
          : {
              role: 'assistant',
              content: completion.content,
              tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            };
        const next: LlmMessage[] = [...messages, assistant];
        for (const r of refused) {
          record(r.call.name, r.call.args, r.text);
          next.push(react ? { role: 'user', content: `Observation: ${r.text}` } : { role: 'tool', tool_call_id: r.call.id, content: r.text });
        }
        const invalidCalls = cur.invalidCalls ?? 0;
        if (refused.length > 0 && invalidCalls >= MAX_ARG_REPAIR_ATTEMPTS) {
          const last = refused[0];
          return failNode(
            config,
            node,
            cur.input,
            new Error(`the model kept sending invalid arguments for ${last.call.name} (${last.problem}) — ${invalidCalls + 1} attempts in a row, and nothing was executed`),
            { ...cur, steps, react },
          );
        }
        // THE HOLD DECISION, ONCE PER CALL (WP-26). Made here, in the superstep that produced the
        // calls, and checkpointed in `holds` with it — before `tools_<id>` can pause on any of them.
        // On resume LangGraph re-runs the PAUSED node only, so the decision cannot be re-asked.
        // Resource grants first: a call the grants refuse is never put in front of an approver.
        const holds: Record<string, HoldEntry> = {};
        const advertisedNow = new Set(tools.map((t) => t.name));
        for (const c of runnable) {
          if (!advertisedNow.has(c.name) || c.name === SET_STATE_TOOL_NAME || c.name === DELEGATE_TOOL || c.name === ESCALATE_TOOL) continue;
          const key = holdKey(id, state.nodeRuns.length, cur.iterations + 1, c.id);
          const no = deps.precheck ? await deps.precheck(c.name, c.args) : null;
          if (no) {
            holds[key] = { held: false, refused: no.text, reason: "outside the system's resource grants" };
            continue;
          }
          const rule = deps.hold ? deps.hold.decide(c.name) : ({ held: false } as const);
          holds[key] = rule.held ? { held: true, approverRole: rule.approverRole, reason: `held for ${rule.approverRole} approval` } : { held: false, reason: deps.hold ? 'not held by the rule' : 'no hold rule' };
        }
        return {
          current: {
            ...cur,
            react,
            steps,
            messages: next,
            iterations: cur.iterations + 1,
            pending: runnable,
            gate: undefined,
            invalidCalls: refused.length > 0 ? invalidCalls + 1 : 0,
            // Nothing left to run: the model answers the error(s) in the next ACT.
            again: runnable.length === 0,
          },
          budget: spent,
          ...(Object.keys(holds).length > 0 ? { holds } : {}),
        };
      } catch (e) {
        if (isGraphBubbleUp(e)) throw e;
        return failNode(config, node, cur.input, e, cur);
      }
    };

    // --------------------------------------------------------------- tools --
    /**
     * Two phases, both safe under LangGraph's re-run-from-start on resume:
     *   1. GATE: the FIRST held call of the batch that has no decision yet pauses the run on ONE
     *      `interrupt()` (no loop, no queue I/O, no side effect before it). The hold itself was
     *      decided once in `act_<id>` and is read from `state.holds`; the decision comes back as
     *      the resume value (validated by `HOLD_ANSWER`) and is recorded in this superstep's
     *      update, so the next held call pauses in the NEXT superstep — one interrupt each, each
     *      with its own stable interrupt id. Nothing executes until every held call is decided.
     *   2. EXECUTE one call per superstep (checkpointed before the next): the node-level gate, the
     *      dedup ledger, a refused/rejected call's typed result, else the governed executor AS THE RUNNER.
     */
    const toolsNode: NodeBody = async (state, config, obs) => {
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`tools_${id}: no agent visit in flight`);
      // THE NODE-LEVEL GATE: only the tools THIS node is advertised may reach the executor.
      const advertised = new Set(toolsFor(node).map((t) => t.name));
      const holds = state.holds ?? {};
      const roundPrefix = holdKey(id, state.nodeRuns.length, cur.iterations, '');
      // ONE-RELEASE SHIM: a batch checkpointed by the previous engine has NO `holds` entries at all
      // (this engine writes one for every gated call of a round). Only for such a batch is the rule
      // asked here, as the previous engine did; `run.ts` refuses to resume one with more than one
      // held call. Any other missing entry fails closed.
      const legacyRound = !Object.keys(holds).some((k) => k.startsWith(roundPrefix));
      const entryOf = (c: ToolCall): HoldEntry | undefined => {
        if (!advertised.has(c.name) || c.name === SET_STATE_TOOL_NAME || c.name === DELEGATE_TOOL || c.name === ESCALATE_TOOL) return undefined;
        const e = holds[holdKey(id, state.nodeRuns.length, cur.iterations, c.id)];
        if (e) return e;
        if (!deps.hold) return undefined;
        if (!legacyRound) return FAIL_CLOSED_HOLD;
        const legacyRefused = cur.gate?.refused?.[c.id];
        if (legacyRefused !== undefined) return { held: false, refused: legacyRefused, reason: "outside the system's resource grants" };
        const rule = deps.hold.decide(c.name);
        return rule.held ? { held: true, approverRole: rule.approverRole, reason: `held for ${rule.approverRole} approval` } : { held: false, reason: 'not held by the rule' };
      };
      const decisions = cur.gate?.decisions ?? {};

      // Phase 1 — pause for the next undecided held call (at most ONE interrupt per superstep).
      const waiting = cur.pending.find((c) => {
        const e = entryOf(c);
        return !!e && e.held && e.refused === undefined && decisions[c.id] === undefined;
      });
      if (waiting) {
        const e = entryOf(waiting)!;
        const payload: HoldInterrupt = {
          kind: 'os.hold',
          tool: waiting.name,
          node: id,
          callId: waiting.id,
          args: boundedHoldArgs(waiting.args),
          approverRole: e.approverRole ?? 'admin',
          reason: e.reason,
        };
        const answer = interrupt<HoldInterrupt, HoldAnswer>(payload, { responseSchema: HOLD_ANSWER });
        // After the decision: the trace records that the call was held and how it was decided.
        obs.toolEvent(waiting, { decision: 'held', approvalId: answer.approvalId, detail: `held for ${payload.approverRole} approval — ${answer.decision}` });
        return { current: { ...cur, gate: { ...(cur.gate ?? {}), decisions: { ...decisions, [waiting.id]: { approvalId: answer.approvalId, decision: answer.decision } } } } };
      }

      // Phase 2 — execute exactly ONE pending call this superstep.
      const [call, ...rest] = cur.pending;
      if (!call) return { current: { ...cur, pending: [], gate: undefined } };
      const messages = [...cur.messages];
      const steps = [...cur.steps];
      const executed = cur.executed.map((e) => ({ ...e }));
      const held: HeldCall[] = [];
      /** A5-review-H-2: the channel this call wrote, applied to state in this superstep's update. */
      let stateWrite: { channel: string; value: unknown } | null = null;
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
      } else if (prior && prior.unresolved && isWriteTool(call.name)) {
        // EXACTLY-ONCE FOR A WRITE WE CANNOT ASK ABOUT (review M-3). The prior attempt timed out:
        // the engine stopped waiting, so the write may have committed. Sending it again is how
        // one `insert_rows` becomes two rows. The model gets a typed `unresolved_previous_call`
        // and is told to READ first; a read with the same signature still re-dispatches, because
        // re-reading is free and is exactly how it should resolve the uncertainty.
        repeatedCalls += 1;
        executed[priorIdx] = { ...prior, count: prior.count + 1 };
        const out = unresolvedWriteRepeat(call.name);
        obs.toolEvent(call, { decision: 'dedup', detail: 'repeat of an UNRESOLVED write — not re-dispatched' });
        record(out.text, true);
        feed(out.text);
      } else {
        const gate = decisions[call.id];
        const holdEntry = entryOf(call);
        let out: { text: string; isError: boolean };
        if (!advertised.has(call.name)) {
          out = notAdvertisedResult(id, call.name);
          obs.toolEvent(call, { decision: 'not_advertised' });
        } else if (call.name === SET_STATE_TOOL_NAME) {
          // THE CHANNEL WRITE (A5-review-H-2). Closed to the DECLARED channels and type-checked
          // against the declaration; it never reaches `deps.callTool`, because there is no OS
          // object behind it — the team's own state is the whole effect. The write is returned in
          // this superstep's update, so `route_<id>` evaluates its guards against the new value.
          const parsed = parseStateWrite(call.args, settable);
          if ('error' in parsed) {
            out = badStateWrite(parsed.error);
            obs.toolEvent(call, { decision: 'error', detail: parsed.error });
          } else {
            stateWrite = parsed;
            out = { text: JSON.stringify({ ok: true, channel: parsed.channel, value: parsed.value }), isError: false };
            obs.toolEvent(call, { decision: 'ok', detail: `state.${parsed.channel} = ${JSON.stringify(parsed.value)}` });
          }
        } else if (call.name === DELEGATE_TOOL && deps.lead?.delegate) {
          // THE DELEGATION (strong leads): a bounded, read-only sub-task for the worker, run by the OS's own primitive. It
          // never reaches the governed executor (the worker has no tools), and it sees only this visit's earlier results.
          out = await deps.lead.delegate(call.args, { results: steps.map((s) => ({ tool: s.tool, text: s.result })) });
          obs.toolEvent(call, { decision: out.isError ? 'error' : 'ok', detail: 'delegate_to_worker' });
        } else if (holdEntry?.refused !== undefined) {
          // Outside the system's resource grants: the typed refusal, and the executor is not reached.
          out = { text: holdEntry.refused, isError: true };
          obs.toolEvent(call, { decision: 'denied', detail: 'outside the system\'s resource grants — not executed' });
        } else if (gate && gate.decision === 'reject') {
          out = rejectedResult(call.name, gate.approvalId);
          obs.toolEvent(call, { decision: 'denied', approvalId: gate.approvalId, detail: 'rejected in Governance' });
        } else if (gate && gate.decision === 'withdraw') {
          // Withdrawn by the run's initiator: same path as a rejection — the executor is never
          // reached — with its own typed result, so nobody reads it as a refusal.
          out = withdrawnResult(call.name, gate.approvalId);
          obs.toolEvent(call, { decision: 'denied', approvalId: gate.approvalId, detail: 'withdrawn by the requester — not executed' });
        } else {
          // Approved or never held: the UNCHANGED governed executor, as the runner (gate 2 = handleRpc(user)).
          // A3: recorded as a span carrying the decision (`ok`, or `denied`/`error` from the result).
          // X9: the governed executor is UNCHANGED (identity, grants and policy are its job); what
          // the engine adds around it is a DEADLINE (so a slow Trino query cannot hang the
          // superstep) and a BOUND on the result (so a 50k-row answer cannot enter the prompt
          // whole). Both protect every tool, not just the data ones.
          out = await obs.tool(call, { decision: 'ok', approvalId: gate?.approvalId }, () =>
            callToolGuarded(deps.callTool, call, {
              timeoutMs: deps.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
              maxChars: deps.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
              // WP-26: the same key on every replay of this step, so the governed executor's
              // ledger (`tool-call-ledger.ts`) can refuse to dispatch a write twice.
              idempotencyKey: `${String(config.configurable?.thread_id ?? '')}:${holdKey(id, state.nodeRuns.length, cur.iterations, call.id)}`,
            }),
          );
        }
        if (gate) held.push({ node: id, tool: call.name, callId: call.id, approvalId: gate.approvalId, decision: gate.decision });
        const entry: ExecutedSig = { sig, count: (prior?.count ?? 0) + 1, ok: !out.isError, ...(isUnresolved(out.text) ? { unresolved: true } : {}) };
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
      const update: Partial<EngineUpdate> = {
        current: { ...cur, messages, steps, executed, repeatedCalls, errorStreakTool, errorStreak, forcedStop, pending, gate: pending.length > 0 ? cur.gate : undefined },
        held,
      };
      // The declared channel is a real state key; its reducer (last value) applies it.
      if (stateWrite) (update as Record<string, unknown>)[stateWrite.channel] = stateWrite.value;
      return update;
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
          // The engine holds on a graph interrupt, never on a user-confirm park (see `engineHeldGate`).
          pending: [],
        };
        const status = nodeStatus(result);
        ownRuns.push({ node: id, model: cur.model, tier: cur.tier, tierReason: cur.tierReason, status, result, input: cur.input, ...(cur.truncated ? { truncated: true as const } : {}) });
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
          const decision = await decideRoute(state, node, members, modelFor(obs, config, id, `llm.route_${id}`));
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
    const base = nodeSystem(deps.preamble, node, state.handoffs, deps.budget, deps.roleOf?.(node.id)) + stateSnapshot(channelValues(state), settable);
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
        messages: fitRequest(deps, node.id, [{ role: 'system', content: base + routeInstructions(members, false) }, ...turns], budget, toOpenAiTools([routeTool(members)])),
        tools: toOpenAiTools([routeTool(members)]),
        temperature: 0.2,
        maxTokens: outMax(deps, routed.model),
      });
    } catch (e) {
      if (!(e instanceof ToolCallingUnsupportedError)) throw e;
      completion = await llm({
        model: routed.model,
        messages: fitRequest(deps, node.id, [{ role: 'system', content: base + routeInstructions(members, true) }, ...turns], budget),
        temperature: 0.2,
        maxTokens: outMax(deps, routed.model),
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
    // A FAILED visit ends the run here (`failNode` set `failed`): no tools, no route, no handoff.
    // …and a reply that could not be acted on (invalid arguments, a cut-off call, an empty reply)
    // comes back to `act_<id>` with what the model was told, instead of going on as an answer.
    builder = builder.addConditionalEdges(nn.act, (s: EngineState) => (s.failed ? END : s.current && s.current.pending.length > 0 ? nn.tools : s.current?.again ? nn.act : nn.route), {
      [nn.tools]: nn.tools,
      [nn.act]: nn.act,
      [nn.route]: nn.route,
      [END]: END,
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

