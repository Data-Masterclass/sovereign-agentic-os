/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The compact tool set of a chat call, and the governed way to load more inside the turn
 * USER STORY: As the owner I want a chat call to carry about two dozen tool definitions instead of 112, because the
 *             definitions were about 95% of what a turn cost, and I want the rest one governed call away.
 * ARCHITECTURE:
 *   - A call offers: the CORE read/find set (the same names as the external fast surface in `fast-surface.ts`), the
 *     current tab's tools, and the toolsets strong loaded with `enable_tools` earlier in THIS turn. Everything is
 *     intersected with what the user's ROLE may list, so loading can never widen what a role is allowed.
 *   - `enable_tools({ toolsets })` is a harness-local tool (the harness `localTools`), read-only: it only changes
 *     which definitions the next call carries. It is NOT the external `load_toolset` (that one stays on the MCP door).
 *   - Hiding is a convenience, the refusal is the control: a call to a tool that is not loaded is refused with
 *     `tool_not_loaded` BEFORE the confirm gate and the governed door (`closed` in the turn's gate), so nothing is
 *     parked, nothing is dispatched. A loaded tool still goes through the confirm gate, the role floor and OPA.
 *   - A toolset is a tab of the registry (`data`, `knowledge`, ...); a tool added tomorrow lands in its tab's toolset.
 */
import type { ToolSpec } from '@core/runtime/agentic';

export const ENABLE_TOOLS = 'enable_tools';

/** The core read/find set: what everyday questions need. A name that is not registered on a build is simply absent. */
export const CHAT_CORE_TOOLS: readonly string[] = [
  'whoami', 'find', 'list_capabilities', 'get_guide',
  'list_datasets', 'get_dataset', 'query_data',
  'list_metrics', 'get_metric', 'query_metric',
  'list_files', 'search_files', 'get_file',
  'list_knowledge', 'get_knowledge', 'search_knowledge',
  'list_dashboards', 'list_agent_systems', 'get_agent_system',
  'list_software', 'list_connections', 'list_approvals',
];

/** What each toolset (a registry tab) is for: shown to strong in the prompt and in refusals. */
export const TOOLSET_INFO: Record<string, string> = {
  data: 'create, ingest, transform, document, quality-check, sync and promote datasets',
  knowledge: 'author, index, publish and retire knowledge; OKF bundles',
  files: 'upload files and reindex the corpus',
  metrics: 'define, preview and promote KPIs',
  dashboards: 'create dashboards',
  agents: 'create, build, run and resume agent systems',
  software: 'design, build, preview, verify, deploy and retire apps',
  connections: 'create, test, configure, promote and retire connections; exposure sets; catalog',
  governance: 'approvals, certification, lineage, history, versions, go-live and retire',
  monitoring: 'monitoring panels, costs and run traces',
  'operating-manual': 'the operating manual and its versions',
  meta: 'conversations and platform helpers',
};

/** The prompt block that tells strong the set is compact and how to load more. */
export function toolsetBlock(): string {
  return [
    '--- TOOLS ---',
    'You start with a compact core set of read and find tools (plus the current tab\'s). To use any other tool, load its toolset',
    'first with `enable_tools({"toolsets":[...]})`; a tool that is not loaded is refused. Loading never widens what your role may do.',
    `Toolsets: ${Object.entries(TOOLSET_INFO).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
  ].join('\n');
}

export const ENABLE_TOOLS_SPEC: ToolSpec = {
  name: ENABLE_TOOLS,
  description: 'Load more tool definitions for the rest of this turn. Read-only: it changes which tools you are offered, not what you are allowed to do.',
  inputSchema: {
    type: 'object',
    properties: { toolsets: { type: 'array', items: { type: 'string', enum: Object.keys(TOOLSET_INFO) }, description: 'Toolsets to load.' } },
    required: ['toolsets'],
  },
};

export type ToolLoader = {
  /** The definitions to send on the next call (role-limited), the local tool included. */
  offered: () => ToolSpec[];
  /** Is this tool offered right now? */
  isLoaded: (name: string) => boolean;
  /** The `enable_tools` handler. */
  enable: (args: Record<string, unknown>) => { text: string; isError: boolean };
};

export function createToolLoader(input: {
  roleTools: ToolSpec[];
  tabOf: (name: string) => string | undefined;
  /** The tab the user is on (its tools are offered up front). */
  tab: string | null;
  /**
   * Tools that belong to no registry tab and are always offered when the role has them: the user's own external
   * connections (Notion) and their import tools. They are few, the user's own, and still go through the confirm gate
   * and OPA, so offering them up front widens nothing.
   */
  alwaysOffered?: ReadonlySet<string>;
}): ToolLoader {
  const loaded = new Set<string>();
  const core = new Set(CHAT_CORE_TOOLS);
  const inRole = new Set(input.roleTools.map((t) => t.name));
  const isLoaded = (name: string): boolean => {
    if (name === ENABLE_TOOLS) return true;
    if (!inRole.has(name)) return false;
    if (core.has(name) || input.alwaysOffered?.has(name)) return true;
    const tab = input.tabOf(name);
    return tab !== undefined && (tab === input.tab || loaded.has(tab));
  };
  return {
    isLoaded,
    offered: () => [...input.roleTools.filter((t) => isLoaded(t.name)), ENABLE_TOOLS_SPEC],
    enable: (args) => {
      const asked = Array.isArray(args.toolsets) ? args.toolsets.filter((x): x is string => typeof x === 'string') : [];
      const unknown = asked.filter((t) => !(t in TOOLSET_INFO));
      if (asked.length === 0 || unknown.length > 0) {
        return { isError: true, text: JSON.stringify({ error: { code: 'unknown_toolset', reason: asked.length === 0 ? 'toolsets must name at least one toolset.' : `Unknown toolset: ${unknown.join(', ')}.`, hint: `Choose from: ${Object.keys(TOOLSET_INFO).join(', ')}.` } }) };
      }
      const before = new Set(input.roleTools.filter((t) => isLoaded(t.name)).map((t) => t.name));
      for (const t of asked) loaded.add(t);
      const added = input.roleTools.filter((t) => isLoaded(t.name) && !before.has(t.name)).map((t) => t.name);
      return { isError: false, text: JSON.stringify({ enabled: asked, tools_now_available: added, note: 'These tools are offered from your next call. Writes still ask the user to confirm.' }) };
    },
  };
}
