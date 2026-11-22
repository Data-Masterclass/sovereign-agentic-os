/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Deprecated MCP tool names that still work for one release.
 * USER STORY: As the owner of an MCP client or an agent system written against the old
 *             vocabulary, I want `author_knowledge` and its siblings to keep working after the
 *             Workflows tools were split from the Knowledge tools, and I want the OS to tell its
 *             operator that a client still uses an old name, so it can be moved before removal.
 * ARCHITECTURE:
 *   - A workflow (`wf_…`, a business process: steps + actors) and a knowledge note (`pk_…`) are two
 *     artifacts. The first MCP surface named the workflow tools `*_knowledge`. They are now
 *     `*_workflow`. This map is the ONLY place that records the old names.
 *   - A deprecated name is NOT a second tool. It is absent from `tools/list`, from every per-tab
 *     view and from `list_capabilities` (so a model is never offered it); a call by that name is
 *     resolved to the current tool in the dispatcher, logged, and run through the SAME governed
 *     handler (same role floor, same OPA gate, same audit). Nothing about the call is widened.
 *   - REMOVAL: delete the entries here (and the `OS_TOOL_ALIASES` spread in `os-tools.ts`) in the
 *     release after the one that ships this file.
 *   - Pure: no `server-only`, no tab import.
 */

/** Old tool name → the tool that replaced it. Every target is a Workflows-tab tool. */
export const DEPRECATED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  author_knowledge: 'author_workflow',
  index_knowledge: 'index_workflow',
  publish_knowledge: 'publish_workflow',
  retire_knowledge: 'retire_workflow',
};

/** The current name for a deprecated tool name, or `null` when `name` is not deprecated. */
export function currentToolName(name: string): string | null {
  return Object.hasOwn(DEPRECATED_TOOL_ALIASES, name) ? DEPRECATED_TOOL_ALIASES[name] : null;
}

/** Where a deprecation notice goes. Replaceable so a test can observe it. */
export type DeprecationSink = (line: string) => void;

let sink: DeprecationSink = (line) => console.warn(line);

/** Test seam: route deprecation notices elsewhere; returns the previous sink. */
export function setDeprecationSink(next: DeprecationSink): DeprecationSink {
  const prev = sink;
  sink = next;
  return prev;
}

/** One line per call, naming the old tool, the new one and who called. Never carries arguments. */
export function logDeprecatedTool(oldName: string, newName: string, via: 'mcp' | 'agent', who?: string): void {
  sink(`[os-ui] DEPRECATED tool name '${oldName}' called via ${via}${who ? ` by ${who}` : ''}: use '${newName}' instead. The old name is removed in the next release.`);
}
