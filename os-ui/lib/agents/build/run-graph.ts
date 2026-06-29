/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type IR } from '../langgraph-compile.ts';
import { invokeTool, type Effect, type Gateway } from '../gateway.ts';

/**
 * A deterministic MOCK LangGraph test-invocation over a compiled {@link IR}. It
 * walks the graph from the entrypoint (supervisor → members ∪ END, following
 * handoff Commands), and — crucially — drives EVERY node's tools through the
 * governed {@link invokeTool} gateway. There is no path here that runs a tool
 * without authorizing + tracing it, so the LangGraph build adapter's `verify`
 * exercises the same chokepoint the real runtime does.
 */

export type RunStep = { node: string; tool: string; effect: Effect; ran: boolean };

export type RunResult = {
  ok: boolean;
  reachedEnd: boolean;
  steps: RunStep[];
  path: string[];
  traces: number;
};

export type RunOptions = {
  gateway: Gateway;
  /** Map a node id to the agent's governed principal (default: the id itself). */
  principalOf?: (nodeId: string) => string;
  /** The mock tool side effect; only invoked for ALLOWED calls. */
  toolRunner?: (principal: string, tool: string, args: Record<string, unknown>) => unknown;
  /** A test prompt threaded through as the tool input. */
  probe?: string;
};

export async function runGraph(ir: IR, opts: RunOptions): Promise<RunResult> {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const commandsByFrom = new Map<string, string[]>();
  for (const c of ir.commands) {
    const list = commandsByFrom.get(c.from) ?? [];
    list.push(c.to);
    commandsByFrom.set(c.from, list);
  }

  const principalOf = opts.principalOf ?? ((id: string) => id);
  const toolRunner = opts.toolRunner ?? (() => 'ok');
  const probe = opts.probe ?? 'test invocation';

  const steps: RunStep[] = [];
  const path: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [ir.entrypoint];
  let reachedEnd = false;

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodeById.get(id);
    if (!node) continue;
    path.push(id);

    for (const tool of node.tools) {
      const principal = principalOf(id);
      const args = { probe, node: id };
      const call = await invokeTool(opts.gateway, principal, tool, args, () => toolRunner(principal, tool, args));
      steps.push({ node: id, tool, effect: call.decision.effect, ran: call.ok });
    }

    const handoffs = commandsByFrom.get(id) ?? [];
    if (node.supervisor) {
      for (const m of node.members) if (!visited.has(m)) queue.push(m);
      reachedEnd = true; // the router always includes END
    }
    for (const to of handoffs) if (!visited.has(to)) queue.push(to);
    if (!node.supervisor && handoffs.length === 0) reachedEnd = true; // a leaf reaches END
  }

  return { ok: reachedEnd, reachedEnd, steps, path, traces: steps.length };
}
