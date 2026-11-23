/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The tool names a run of an agent system can send to LiteLLM — the ONE list its key allows
 * USER STORY: As the owner I want my agent system's runs never refused by the gateway with
 *             `tool_access_denied` for a tool the OS itself offered the model, and its key to allow
 *             nothing a run never offers.
 * ARCHITECTURE:
 *   - The key's `metadata.allowed_tools` (`live.ts` `keyWanted`) is THIS list, and this list is built
 *     from the very functions the run path uses to assemble each request's `tools`:
 *       · governed tools per agent — `nodeGrantedMcpTools` (`os-tools.ts`), the pool `grantedToolSpecs`
 *         hands every node before the runner's role narrows it (a key serves every runner);
 *       · the system the run executes — `withOutputTools` (`run-service.ts` `prepareRun`), so a declared
 *         output's write tool is in (prod incident 21 Nov 2026);
 *       · the engine's own tools — `engineToolNames` (`engine/build-graph.ts`): the lead tool
 *         (`delegate_to_worker` / `escalate_to_strong`, either way the OS-wide lead switch is set),
 *         `os_set_state` for a channel writer, `route` for a supervisor (dev incident 23 Nov 2026);
 *       · the module engine's own tools — `moduleEngineToolNames` (`module/generate.ts`).
 *     A new tool the run offers is added in one of those functions, and the key follows.
 *   - Not here, on purpose: raw legacy grant names and `connection_<id>` (the OPA vocabulary,
 *     `grantVocabulary`, never sent to the model); `enable_tools` (the assistant chat only).
 */
import type { System } from '@tabs/agents/lib/system-schema';

/**
 * The revision of the rule below, stamped on every key the OS writes (`metadata.os_allowed_tools_rev`).
 * BUMP IT whenever the rule changes the list for an existing system. A key whose `allowed_tools`
 * differ from the definition AND whose stamp is older was written by an earlier OS release, not edited
 * by a person — so the continuous reconcile re-stamps it automatically (`key-reconcile.ts`).
 *   1 (implicit, no stamp) — the grant vocabulary (raw grants ∪ resolved MCP names ∪ connections).
 *   2 — what a run offers: governed tools per agent, output writes, engine and lead tools.
 */
export const ALLOWED_TOOLS_REV = 2;

/** Every tool name a run of `input` can put in a model request, sorted. */
export async function runOfferedToolNames(input: System): Promise<string[]> {
  const [{ withOutputTools }, { compile }, { nodeGrantedMcpTools }, { engineToolNames }, { moduleTeam, moduleEngineToolNames }] = await Promise.all([
    import('@tabs/agents/lib/output-tools'),
    import('@tabs/agents/lib/langgraph-compile'),
    import('@tabs/agents/lib/build/os-tools'),
    import('@tabs/agents/lib/engine/build-graph'),
    import('@tabs/agents/lib/module/generate'),
  ]);
  const sys = withOutputTools(input);
  const ir = compile(sys);
  const names = new Set<string>();
  for (const node of ir.nodes) for (const t of nodeGrantedMcpTools(sys, node.tools)) names.add(t.name);
  for (const t of engineToolNames(ir)) names.add(t);
  for (const t of moduleEngineToolNames(moduleTeam(sys, ir))) names.add(t);
  return [...names].sort();
}
