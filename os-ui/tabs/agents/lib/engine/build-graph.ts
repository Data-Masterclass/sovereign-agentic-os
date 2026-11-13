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
 *     reach the governed executor; a held write comes back as the executor's typed `held`
 *     result and is recorded in `state.held`; A2 turns it into `interrupt()`), `route_<id>`
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
 */
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
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

// ------------------------------------------------------------------- types --

/** What the graph needs from its host — the walker's deps minus the live hooks (events flow through the stream writer). */
export type GraphDeps = Omit<AgenticGraphDeps, 'onNodeStart' | 'onStep' | 'onNodeComplete' | 'tieBreaker'> & {
  /** Checkpoint store (Postgres in the cluster, memory in tests). Absent → no checkpointing. */
  checkpointer?: BaseCheckpointSaver;
  /** Legacy grant names that resolve to no governed MCP tool — a compile error naming them. */
  unmappedTools?: string[];
};

/** A write the governed executor HELD for approval during this run (A2 interrupts here). */
export type HeldCall = { node: string; tool: string; callId: string };

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

function isHeldResult(text: string): boolean {
  try {
    return (JSON.parse(text) as { error?: { code?: string } })?.error?.code === 'held';
  } catch {
    return false;
  }
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

/**
 * Build the compiled StateGraph for one IR. Throws {@link GraphCompileError} for an unmapped
 * legacy tool, a malformed `when`, a channel shadowing an engine key, a disabled entrypoint or
 * colliding sanitised node names. Returns compile WARNINGS (never throws) for guards over
 * channels nothing sets.
 */
export function buildGraph(ir: IR, deps: GraphDeps): BuiltGraph {
  const warnings: string[] = [];
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
    const plan: NodeFn = async (state, config) => {
      const stepsUsed = state.budget.stepsUsed;
      if (stepsUsed >= stepBudget) {
        return new Command({ goto: END, update: { budget: { stepsUsed, exhausted: true }, current: null } });
      }
      const turns = conversation(state.messages);
      const userTask = turns.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const transcript = await curatePredecessor(state.handoffs, node, userTask, deps);
      const system = nodeSystem(deps.preamble, node, transcript, deps.budget);
      const input = boundInput(system + renderUserTurn(turns));
      emit(config, { event: 'node-started', data: { node: id, index: state.nodeRuns.length + 1, total } });
      try {
        const routed = resolveNodeModel(node, deps);
        const completion = await deps.llm({
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
          maxIterations: perVisitCap(stepsUsed),
          react: false,
          pending: [],
          finalText: '',
          forcedStop: false,
          repeatedCalls: 0,
          errorStreakTool: '',
          errorStreak: 0,
        };
        return new Command({ goto: nn.act, update: { current: cursor } });
      } catch (e) {
        if (isGraphBubbleUp(e)) throw e;
        return failNode(config, node, input, e);
      }
    };

    // ----------------------------------------------------------------- act --
    const act: NodeFn = async (state, config) => {
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`act_${id}: no agent visit in flight`);
      const tools = deps.toolSpecsFor(node);
      const budget = deps.budget ?? 24_000;
      try {
        // Cap reached (or a loop guard fired): ONE final no-tools synthesis, then the soft cap note.
        if (cur.iterations >= cur.maxIterations || cur.forcedStop) {
          let finalText = '';
          try {
            const synth = await deps.llm({
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
          completion = await deps.llm({
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
          completion = await deps.llm({ model: cur.model, messages: budgetMessages(messages, budget), temperature: 0.2, maxTokens: deps.maxOutputTokens });
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
          current: { ...cur, react, messages: [...messages, assistant], iterations: cur.iterations + 1, pending: calls },
          budget: { stepsUsed: state.budget.stepsUsed + 1, exhausted: false },
        };
      } catch (e) {
        if (isGraphBubbleUp(e)) throw e;
        return failNode(config, node, cur.input, e);
      }
    };

    // --------------------------------------------------------------- tools --
    const toolsNode: NodeFn = async (state, config) => {
      const cur = state.current;
      if (!cur || cur.node !== id) throw new Error(`tools_${id}: no agent visit in flight`);
      // THE NODE-LEVEL GATE: only the tools THIS node is advertised may reach the executor.
      const advertised = new Set(deps.toolSpecsFor(node).map((t) => t.name));
      const messages = [...cur.messages];
      const steps = [...cur.steps];
      const executed = cur.executed.map((e) => ({ ...e }));
      const held: HeldCall[] = [];
      let repeatedCalls = cur.repeatedCalls;
      let errorStreakTool = cur.errorStreakTool;
      let errorStreak = cur.errorStreak;
      let forcedStop = false;
      const feed = (call: ToolCall, text: string) => {
        if (cur.react) messages.push({ role: 'user', content: `Observation: ${text}` });
        else messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      };
      const record = (call: ToolCall, result: string, isError: boolean) => {
        const step: AgenticStep = { tool: call.name, args: call.args, result, isError };
        steps.push(step);
        emit(config, { event: 'tool-step', data: { node: id, step, index: steps.length } });
      };

      for (const call of cur.pending) {
        const sig = toolCallSignature(call.name, call.args);
        const priorIdx = executed.findIndex((e) => e.sig === sig);
        const prior = priorIdx >= 0 ? executed[priorIdx] : undefined;
        if (prior && prior.ok) {
          // Exact repeat of a SUCCESSFUL call: never re-run; answer with the short dedup note.
          repeatedCalls += 1;
          executed[priorIdx] = { ...prior, count: prior.count + 1 };
          const note = dedupNote(prior.count);
          record(call, note, false);
          feed(call, note);
          continue;
        }
        // Hold decision + governed dispatch live in the UNCHANGED executor (grantedToolExecutor):
        // a held write returns its typed `held` result here and is recorded in state.held.
        const out = advertised.has(call.name) ? await deps.callTool(call.name, call.args) : notAdvertisedResult(id, call.name);
        const entry: ExecutedSig = { sig, count: (prior?.count ?? 0) + 1, ok: !out.isError };
        if (priorIdx >= 0) executed[priorIdx] = entry;
        else executed.push(entry);
        record(call, out.text, out.isError);
        if (out.isError && isHeldResult(out.text)) held.push({ node: id, tool: call.name, callId: call.id });
        if (out.isError && call.name === errorStreakTool) {
          errorStreak += 1;
        } else {
          errorStreakTool = out.isError ? call.name : '';
          errorStreak = out.isError ? 1 : 0;
        }
        const streakBroken = errorStreak >= DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS;
        feed(call, streakBroken ? errorStreakNote(errorStreak, call.name) : out.text);
        if (streakBroken) {
          forcedStop = true;
          break;
        }
      }
      if (repeatedCalls >= DEFAULT_MAX_REPEATED_CALLS) forcedStop = true;
      return {
        current: { ...cur, messages, steps, executed, repeatedCalls, errorStreakTool, errorStreak, forcedStop, pending: [] },
        held,
      };
    };

    // --------------------------------------------------------------- route --
    const route: NodeFn = async (state, config) => {
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
          const decision = await decideRoute(state, node, members);
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
    entries.push([nn.plan, plan, { ends: planEnds }]);
    entries.push([nn.act, act]);
    entries.push([nn.tools, toolsNode]);
    entries.push([nn.route, route, routeEnds ? { ends: routeEnds } : undefined]);
  }

  /** Ask the supervisor's model where to go next: the mandatory `route` tool, else the `NEXT:` text fallback. */
  async function decideRoute(state: EngineState, node: IRNode, members: string[]): Promise<RouteDecision> {
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
      completion = await deps.llm({
        model: routed.model,
        messages: budgetMessages([{ role: 'system', content: base + routeInstructions(members, false) }, ...turns], budget),
        tools: toOpenAiTools([routeTool(members)]),
        temperature: 0.2,
        maxTokens: deps.maxOutputTokens,
      });
    } catch (e) {
      if (!(e instanceof ToolCallingUnsupportedError)) throw e;
      completion = await deps.llm({
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
    builder = builder.addEdge(nn.tools, nn.act);
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

