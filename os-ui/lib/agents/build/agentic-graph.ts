/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type IR, type IRNode } from '../langgraph-compile.ts';
import {
  runAgentic,
  type AgenticResult,
  type AgenticStep,
  type LlmCall,
  type ToolExecutor,
  type ToolSpec,
} from '@/lib/assistant/agentic';
import { compactToolResult } from '@/lib/infra/context/context-assembler';
import { estimateTokens } from '@/lib/knowledge/context-pack';

/**
 * THE AGENTIC GRAPH EXECUTOR — the core of the Software Delivery Team.
 *
 * It walks a compiled LangGraph {@link IR} and, per node, runs the EXISTING
 * per-user agentic harness ({@link runAgentic}, the same PLAN→ACT loop the live
 * software build chat uses) with:
 *   • that node's model as the ACT model (`node.model ?? execModel`), reasoning
 *     tier for the PLAN — so per-agent model routing is genuinely live;
 *   • that node's narrowed, role-scoped tool specs (injected `toolSpecsFor`);
 *   • the injected governed `callTool` — in production this is
 *     `tabToolExecutor(user,'software')` → `handleRpc(user, …)`, i.e. every tool
 *     runs AS THE RUNNING USER (OPA + role floor + Langfuse), never a system
 *     principal. This closes the run-scope-as-system-principal gap.
 *
 * This module is TRANSPORT-FREE and side-effect-free: `llm`, `callTool` and the
 * per-node tool specs are all INJECTED, so it is trivially unit-testable and
 * carries no `server-only` coupling. The server wiring lives in
 * `agentic-graph-server.ts`.
 *
 * v1 routing is DETERMINISTIC and honest: the compiled `when` guards are not
 * evaluated by any runtime, so we walk the graph in a fixed, visited-once order
 * (entrypoint → supervisor members in declared order, following handoffs) — the
 * same walk `run-graph.ts` uses. The team's single voice (the last node, e.g.
 * `communication`) speaks last, and its final text is the user-facing reply.
 */

/** A node's outcome: 'ok' produced output, 'denied' had a denied/errored tool, 'failed' threw. */
export type NodeStatus = 'ok' | 'failed' | 'denied';

export type NodeRun = {
  node: string;
  model: string;
  status: NodeStatus;
  result: AgenticResult;
  /**
   * A READABLE rendering of what this node was GIVEN: its role prompt + the "TEAM
   * PROGRESS SO FAR" handoff (prior agents' conclusions and material data) + the
   * user turn. Captured so the UI can show "what this agent received" in the
   * drill-down. Size-bounded so a long transcript can't bloat the run response.
   */
  input?: string;
  /** Present only when the node threw — the reason, for a node-level failure surface. */
  error?: string;
};

/** Upper bound on the captured node `input` (chars) so the run response stays lean. */
const MAX_NODE_INPUT_CHARS = 8_000;

/** Bound a captured input string to its head, marking the elision honestly. */
function boundInput(text: string): string {
  return text.length <= MAX_NODE_INPUT_CHARS
    ? text
    : `${text.slice(0, MAX_NODE_INPUT_CHARS)}\n… [truncated ${text.length - MAX_NODE_INPUT_CHARS} more chars]`;
}

/** Render the user turn(s) this node received, appended after its system context. */
function renderUserTurn(messages: { role: 'user' | 'assistant'; content: string }[]): string {
  const last = messages.filter((m) => m.role === 'user').at(-1);
  return last ? `\n\n--- USER TURN ---\n${last.content}` : '';
}

/** Derive a node's status from its run: threw → failed; any denied/errored tool → denied; else ok. */
function nodeStatus(result: AgenticResult, threw?: string): NodeStatus {
  if (threw) return 'failed';
  if (result.steps.some((s) => s.isError)) return 'denied';
  return 'ok';
}

export type AgenticGraphResult = {
  /** The node ids that ran, in order. */
  path: string[];
  /** Each node's model + full PLAN→ACT trace. */
  runs: NodeRun[];
  /** The last node's final text — the team's single user-facing reply. */
  finalText: string;
};

export type AgenticGraphDeps = {
  llm: LlmCall;
  /** The role-scoped tool specs a node may drive (⊆ system grants, per-user). */
  toolSpecsFor: (node: IRNode) => ToolSpec[];
  /** The governed executor — production: runs as the signed-in user. */
  callTool: ToolExecutor;
  /** Preamble shared by every node (OS rules + software tab context). */
  preamble: string;
  /** Reasoning tier used for every node's PLAN step. */
  reasoningModel: string;
  /** Fallback ACT model when a node pins none. */
  execModel: string;
  maxIterations?: number;
  /**
   * Input token ceiling for every node's model call — the bound each node's
   * (growing) transcript is assembled to before it reaches the gateway. Fixes the
   * multi-node LiteLLM 400 ContextWindowExceededError. Forwarded to `runAgentic`;
   * unset uses the harness default.
   */
  budget?: number;
  /** Cap on each node's own model output (the reserved-output tail). */
  maxOutputTokens?: number;
  /** Toggled-off agents: skipped, their tools never run. */
  disabled?: string[];
};

/**
 * The deterministic visit order over the IR: BFS from the entrypoint, a
 * supervisor enqueues its members in declared order, handoffs are followed, and
 * every node runs at most once. Mirrors the walk in `run-graph.ts` so the
 * ordering is identical to the mock test-invocation. Disabled agents are skipped.
 */
export function nodeOrder(ir: IR, disabled: Set<string> = new Set()): string[] {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const commandsByFrom = new Map<string, string[]>();
  for (const c of ir.commands) {
    const list = commandsByFrom.get(c.from) ?? [];
    list.push(c.to);
    commandsByFrom.set(c.from, list);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [ir.entrypoint];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (disabled.has(id)) continue; // skipped: never runs, never routes onward
    const node = nodeById.get(id);
    if (!node) continue;
    order.push(id);
    if (node.supervisor) {
      for (const m of node.members) if (!visited.has(m)) queue.push(m);
    }
    for (const to of commandsByFrom.get(id) ?? []) if (!visited.has(to)) queue.push(to);
  }
  return order;
}

/** One prior node's handoff: its narration PLUS the material data it produced. */
type HandoffEntry = { node: string; block: string };

/**
 * Instruction to the DOWNSTREAM node: the handoff below carries the prior agents'
 * ACTUAL outputs (scorecards, metric values, query rows) — use them, never re-ask
 * the user for data a teammate already produced.
 */
const HANDOFF_DIRECTIVE = [
  'Your teammates have already run before you. "TEAM PROGRESS SO FAR" below carries',
  'each prior agent\'s conclusion AND the material data it produced (query rows,',
  'metric values, scorecards). USE that data directly — it is the input to your job.',
  'NEVER ask the user for information a prior agent already produced; if you need a',
  "prior result, read it from the handoff. Only the most recent agent's output is",
  'pinned in full; older ones may be summarized.',
  '',
  'DO NOT re-run a query or re-compute a result a teammate already handed you. A large',
  'row-set may be shown truncated (e.g. "…(N more rows)") — reason over the rows and',
  'the prior agent\'s conclusion you WERE given; only fetch a source yourself if a',
  'specific value you need is genuinely absent from the handoff, and then fetch just',
  'that one thing. Spend your tool budget on NEW work (your synthesis/recommendation),',
  'not on re-deriving your teammate\'s output.',
].join('\n');

/**
 * Row allowance for inter-node handoffs. A scorecard from the evaluator can span
 * many campaigns — the recommender must see ALL rows to reason over them without
 * re-querying. This is deliberately MUCH larger than the default (5) used for the
 * in-context assembler so a typical scorecard (≤60 campaigns) passes whole.
 * The handoff budget ceiling in `budgetTranscript` / `nodeSystem` still applies as
 * the outer size guard, so this cannot blow the model window.
 */
const HANDOFF_KEEP_ROWS = 60;

/**
 * Render one node's handoff block: its finalText (narration) followed by a compact
 * rendering of its MATERIAL tool outputs — the data it fetched/produced (query
 * result rows, metric values, scorecard) — so a downstream node has the actual
 * results to work from, not just the narration. Errored/denied steps are noted so
 * the next node knows what was NOT obtained. Each result is compacted (row-set →
 * header+first-N up to HANDOFF_KEEP_ROWS; long text → head+tail) so the handoff
 * stays budget-friendly while preserving full scorecards for downstream reasoning.
 */
function handoffBlock(node: string, finalText: string, steps: AgenticStep[]): string {
  const parts = [`## ${node}`, finalText.trim() || '(no narration)'];
  const material = steps.filter((s) => !s.isError && s.result.trim());
  const failed = steps.filter((s) => s.isError);
  if (material.length > 0) {
    parts.push('', `### ${node} — data produced (use this directly):`);
    for (const s of material) {
      // Pass HANDOFF_KEEP_ROWS so a full scorecard (up to 60 rows) is preserved;
      // the global default (5) is only used elsewhere (in-context assembler).
      parts.push(`- ${s.tool}: ${compactToolResult(s.result.trim(), {}, HANDOFF_KEEP_ROWS)}`);
    }
  }
  if (failed.length > 0) {
    parts.push('', `### ${node} — tools that did NOT return data: ${failed.map((s) => s.tool).join(', ')}`);
  }
  return parts.join('\n');
}

/**
 * The share of a node's input budget the between-node handoff may occupy. The rest
 * is preamble + role + the node's own ACT loop. Kept modest so the handoff never
 * crowds out the node's own working context.
 */
const HANDOFF_BUDGET_FRACTION = 0.4;
/** Fallback handoff ceiling (tokens) when no `budget` is supplied by the caller. */
const DEFAULT_HANDOFF_BUDGET = 6_000;

/**
 * Bound the running transcript so the handoff can't blow the budget — biased to keep
 * the MOST RECENT structured output (the thing the next node most needs). Newest
 * entries are kept in full, first; once the ceiling is reached, OLDER entries are
 * compacted to their narration line, and the very oldest dropped. Because the newest
 * is packed first, a downstream node ALWAYS sees the prior node's full data block —
 * `budgetMessages`' pinned-head truncation (which cuts the tail) can no longer strip it.
 */
function budgetTranscript(transcript: HandoffEntry[], ceiling: number): HandoffEntry[] {
  const total = transcript.reduce((n, e) => n + estimateTokens(e.block), 0);
  if (total <= ceiling) return transcript;
  const kept: HandoffEntry[] = [];
  let used = 0;
  // Walk newest → oldest; keep full while it fits, else compact to the narration line.
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const e = transcript[i];
    const full = estimateTokens(e.block);
    if (used + full <= ceiling) {
      kept.unshift(e);
      used += full;
      continue;
    }
    const line = `## ${e.node}\n${e.block.split('\n').slice(1, 3).join(' ')}`.trim();
    const lineTokens = estimateTokens(line);
    if (used + lineTokens <= ceiling) {
      kept.unshift({ node: e.node, block: line });
      used += lineTokens;
    }
    // else: too full even for a summary line — drop this and any older entry.
    else break;
  }
  return kept;
}

/**
 * Compose one node's system prompt: preamble + its AGENT.md + running progress.
 * The team progress carries each prior node's narration AND its structured tool
 * outputs (via {@link handoffBlock}); the MOST RECENT entry is listed last (the
 * budgeter pins recent messages, so the thing this node most needs survives).
 */
function nodeSystem(preamble: string, node: IRNode, transcript: HandoffEntry[], budget?: number): string {
  const ceiling = Math.floor((budget ?? DEFAULT_HANDOFF_BUDGET / HANDOFF_BUDGET_FRACTION) * HANDOFF_BUDGET_FRACTION);
  transcript = budgetTranscript(transcript, ceiling);
  const parts = [preamble, '', `--- YOUR ROLE IN THE TEAM: ${node.id} ---`, node.prompt];
  const memory = node.memory?.trim();
  if (memory && memory !== '# Memory') parts.push('', memory);
  if (transcript.length > 0) {
    parts.push('', HANDOFF_DIRECTIVE, '', '--- TEAM PROGRESS SO FAR ---', transcript.map((e) => e.block).join('\n\n'));
  }
  return parts.join('\n');
}

/**
 * Run the whole team over one turn. For each node in {@link nodeOrder}, run the
 * agentic harness with the node's model + narrowed tools + the shared, growing
 * transcript (the `messages` channel, made real). Returns every node's trace and
 * the single user-facing reply (the last node's final text).
 */
export async function runAgenticGraph(
  ir: IR,
  messages: { role: 'user' | 'assistant'; content: string }[],
  deps: AgenticGraphDeps,
): Promise<AgenticGraphResult> {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const order = nodeOrder(ir, new Set(deps.disabled ?? []));

  const runs: NodeRun[] = [];
  const transcript: HandoffEntry[] = [];
  for (const id of order) {
    const node = nodeById.get(id)!;
    const actModel = node.model ?? deps.execModel;
    // Wrap each node so ONE node's failure is reported as a node-level failure with
    // partial results — never a blank 500 that aborts the whole run. The run stops
    // at the failed node (downstream nodes depend on its output) but every node that
    // ran up to and including it is returned.
    // Compose the node's system context ONCE so we can both run on it AND capture it
    // as the node's readable `input` for the drill-down (what this agent was given).
    const system = nodeSystem(deps.preamble, node, transcript, deps.budget);
    const input = boundInput(system + renderUserTurn(messages));
    try {
      const result = await runAgentic({
        system,
        userMessages: messages,
        tools: deps.toolSpecsFor(node),
        callTool: deps.callTool,
        llm: deps.llm,
        planModel: deps.reasoningModel,
        actModel,
        maxIterations: deps.maxIterations,
        budget: deps.budget,
        maxOutputTokens: deps.maxOutputTokens,
      });
      runs.push({ node: id, model: actModel, status: nodeStatus(result), result, input });
      // Thread this node's finalText AND its material tool outputs forward, so a
      // downstream node has the actual data (scorecard/rows/metrics) to work from.
      transcript.push({ node: id, block: handoffBlock(node.id, result.finalText, result.steps) });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      runs.push({
        node: id,
        model: actModel,
        status: 'failed',
        error,
        input,
        result: { plan: '', steps: [], finalText: `(${id} failed: ${error})`, iterations: 0, toolCallingSupported: true },
      });
      break;
    }
  }

  const finalText = runs.length > 0 ? runs[runs.length - 1].result.finalText : '(no agents ran)';
  return { path: order, runs, finalText };
}

/**
 * Run EXACTLY ONE node of the team for one turn (the phase-router path). Same
 * injected, governed surface as {@link runAgenticGraph}, but a single `runAgentic`
 * call instead of the six-node walk — ~6× fewer LLM calls per turn, and the one
 * node that runs is chosen by the phase router. `extraGuidance` (the phase's
 * instructions) is appended to the node's system prompt; `onStep` streams each
 * governed tool step so the UI shows live progress, never a silent spinner.
 */
export async function runNode(
  ir: IR,
  nodeId: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  deps: AgenticGraphDeps,
  opts: { extraGuidance?: string; onStep?: (step: import('@/lib/assistant/agentic').AgenticStep) => void } = {},
): Promise<NodeRun> {
  const node = ir.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Unknown team node: ${nodeId}`);
  const system = opts.extraGuidance
    ? `${nodeSystem(deps.preamble, node, [])}\n\n--- THIS TURN ---\n${opts.extraGuidance}`
    : nodeSystem(deps.preamble, node, []);
  const actModel = node.model ?? deps.execModel;
  const result = await runAgentic({
    system,
    userMessages: messages,
    tools: deps.toolSpecsFor(node),
    callTool: deps.callTool,
    llm: deps.llm,
    planModel: deps.reasoningModel,
    actModel,
    maxIterations: deps.maxIterations,
    budget: deps.budget,
    maxOutputTokens: deps.maxOutputTokens,
    onStep: opts.onStep,
  });
  return { node: nodeId, model: actModel, status: nodeStatus(result), result, input: boundInput(system + renderUserTurn(messages)) };
}
