/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Build's graph step — compile the REAL StateGraph the run path will execute
 * USER STORY: As a builder I press Build and want the `langgraph` row to mean "the graph this
 *             system.yaml describes can actually be constructed", not "a mock walk visited some
 *             nodes" — so a bad guard, an unmapped grant or a shadowed state channel fails at
 *             Build instead of surprising me mid-run.
 * ARCHITECTURE:
 *   - PURE and tiny: (System, IR) → a verdict. It calls `buildGraph` — the SAME function
 *     `engine/run.ts` compiles with — against inert deps (a model that is never called, a tool
 *     executor that is never called, no checkpointer, no hold port, no observer). Compiling a
 *     StateGraph makes no model and no tool call, so this is a pure structural check.
 *   - A5 replaced two things with this: the live adapter's POST of the IR to the Python
 *     `agent-runtime` `/reload` + a `/run` test invocation, and the mock adapter's hand-rolled
 *     BFS over the IR. Both claimed to verify the graph while executing something ELSE.
 *   - This is also the tripwire that `langgraph-compile.ts`'s output is CONSUMED rather than
 *     merely emitted: Build and Run now both take the IR into `buildGraph`.
 */
import type { System } from '@tabs/agents/lib/system-schema';
import type { IR, IRNode } from '@tabs/agents/lib/langgraph-compile';
import { buildGraph, type GraphDeps } from '@tabs/agents/lib/engine/build-graph';

/** What Build learned by compiling the graph. */
export type CompileVerdict =
  | {
      ok: true;
      /** Active (non-disabled) agents in the compiled graph. */
      nodes: number;
      /** LangGraph nodes — four per agent (plan / act / tools / route). */
      graphNodes: number;
      stepBudget: number;
      recursionLimit: number;
      /** Compile warnings: real, surfaced, never swallowed (a guard over a channel nothing sets, …). */
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Deps that satisfy the type and would throw if the graph ever tried to USE them. Compiling
 * never does — if one of these ever fires, the test that catches it is doing its job.
 */
function inertDeps(unmappedTools: string[], disabled?: string[]): GraphDeps {
  const unreachable = (what: string) => () => {
    throw new Error(`Build's compile check must not ${what}`);
  };
  return {
    llm: unreachable('call a model') as GraphDeps['llm'],
    callTool: unreachable('call a tool') as GraphDeps['callTool'],
    toolSpecsFor: (node: IRNode) => node.tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } })),
    preamble: '',
    reasoningModel: 'compile-check',
    execModel: 'compile-check',
    maxIterations: 1,
    disabled,
    unmappedTools,
  };
}

/**
 * Compile the graph for one system. A compile error (unmapped grant, disabled entrypoint,
 * malformed `when`, channel shadowing an engine key, every agent disabled) becomes
 * `{ ok: false, error }` — the Build row's ✗ with the reason in it.
 */
export async function compileVerify(sys: System, ir: IR, disabled?: string[]): Promise<CompileVerdict> {
  try {
    // Dynamic import: `os-tools.ts` reads the MCP registry at module init and is server-only;
    // this module (like `live.ts`) must stay importable by a unit test.
    const { resolveGrantedTools } = await import('./os-tools.ts');
    const built = buildGraph(ir, inertDeps(resolveGrantedTools(sys).unmapped, disabled));
    return {
      ok: true,
      nodes: built.agents.length,
      graphNodes: built.agents.length * 4,
      stepBudget: built.stepBudget,
      recursionLimit: built.recursionLimit,
      warnings: built.warnings,
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
