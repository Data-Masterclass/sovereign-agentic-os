/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type IR, type IRNode } from '../langgraph-compile.ts';
import {
  runAgentic,
  type AgenticResult,
  type LlmCall,
  type ToolExecutor,
  type ToolSpec,
} from '@/lib/assistant/agentic';

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

export type NodeRun = { node: string; model: string; result: AgenticResult };

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

/** Compose one node's system prompt: preamble + its AGENT.md + running progress. */
function nodeSystem(preamble: string, node: IRNode, transcript: string[]): string {
  const parts = [preamble, '', `--- YOUR ROLE IN THE TEAM: ${node.id} ---`, node.prompt];
  const memory = node.memory?.trim();
  if (memory && memory !== '# Memory') parts.push('', memory);
  if (transcript.length > 0) {
    parts.push('', '--- TEAM PROGRESS SO FAR ---', transcript.join('\n\n'));
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
  const transcript: string[] = [];
  for (const id of order) {
    const node = nodeById.get(id)!;
    const actModel = node.model ?? deps.execModel;
    const result = await runAgentic({
      system: nodeSystem(deps.preamble, node, transcript),
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
    runs.push({ node: id, model: actModel, result });
    transcript.push(`## ${node.id}\n${result.finalText}`);
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
  return { node: nodeId, model: actModel, result };
}
