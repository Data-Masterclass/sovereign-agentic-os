/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import {
  ALL_MCP_TOOLS,
  handleRpc as realHandleRpc,
  listToolsForRole,
  type McpTool,
} from '@core/mcp/server';
import { WRITE_TOOL_NAMES, WRITE_TOOL_TABS } from '@core/mcp/write-tool-meta';
import { DEPRECATED_TOOL_ALIASES, currentToolName, logDeprecatedTool } from '@core/mcp/deprecated-aliases';
import type { ToolExecutor, ToolSpec } from '@core/runtime/agentic';
import type { ArtifactGrant, System, SafetyPreset } from '@tabs/agents/lib/system-schema';
import { type Effect } from '@tabs/agents/lib/gateway';
import { principalFor } from '@tabs/agents/lib/build/runtime-contract';
import { trace as realTrace } from '@core/infra/agent-governed';
import type { RunTraceContext } from '@core/infra/trace-port';
import { runWithRunId } from '@core/infra/request-surface';
import { enqueue as realEnqueue } from '@core/policy/approvals';
import { holdDecision, holdReason, writeTargetScope } from '@tabs/agents/lib/build/hold';
import { agentForbiddenReason } from '@core/mcp/write-tool-meta';
import { resolveFolderGrant } from '@core/kernel/folders';
import { cappedGrantWarning, folderGrantCoverage, zeroMatchWarning, isOutputFolder, type TreeItemRef } from '@tabs/agents/lib/grant-apply';
import { config } from '@core/kernel/config';
import { TAB_FEATURES } from '@core/kernel/tabs';
import { toolSummary } from '@tabs/agents/lib/build/tool-brief';
import { shapeForAgent, type AgentResultContext } from '@tabs/agents/lib/build/agent-tool-results';
import {
  checkGrantScope,
  grantScopeOf,
  type FileLocation,
  type GrantRefusal,
  type GrantResolvers,
  type GrantVerdict,
  type ResourceKind,
} from '@tabs/agents/lib/build/grant-scope';

/**
 * THE ONE reusable core that lets an INTERNAL agent (Agents tab) call the SAME
 * governed OS MCP toolset as an EXTERNAL Claude/ChatGPT client — under the ACTING
 * USER's delegated identity, governed identically. No parallel registry, no forked
 * tool implementations: everything dispatches through `handleRpc(user, …)` exactly
 * like `lib/assistant/runtime.ts` `tabToolExecutor`, just scoped to a system's
 * grants instead of a tab.
 *
 * THE DOUBLE GATE (an agent can exceed NEITHER its grants NOR its runner's rights):
 *   1. Grant scope — the tool must be in the system's `grants.tools` (resolved
 *      through the legacy→MCP alias map). This is ALSO where a WRITE tool is HELD:
 *      a granted write tool (any {@link WRITE_TOOL_NAMES} name) resolves to
 *      `requires_approval`, enqueues to Governance and NEVER executes; a granted
 *      read tool is allowed to reach gate 2. This decision is derived IN-PROCESS
 *      from the system's own resolved grant-set + the write-tool catalog — it does
 *      NOT depend on a live `os-<systemId>` OPA document (which only a Build writes),
 *      so a scaffolded system runs correctly with no prior Build.
 *   1a. Resource scope — the THING the call names (a dataset, knowledge item, metric,
 *      connection, file or plan item) must be inside the system's resource grants, a list or
 *      search comes back narrowed to them, and free-form SQL may name only granted datasets'
 *      tables. Decided in one place, `checkGrantScope` (`grant-scope.ts`), from a declarative
 *      per-tool map; refused calls never reach the hold or the tool.
 *   2. Role floor + governed authority — the actual call runs through
 *      `handleRpc(user, …)`, which re-checks the tool's role floor (`server.ts`)
 *      and runs the governed library under `user:<id>` + domains (OPA/DLS/RLS).
 *      The USER is always the identity of the real side effect — never the service
 *      principal `os-<systemId>`. This is the REAL authority: the owner DLS clause
 *      (own units always visible), the role floor and RLS all live here.
 *
 * The gates are an INTERSECTION: a tool passes only if BOTH the system grant scope
 * AND the user's own role/OPA/DLS allow it. Neither can broaden the other.
 *
 * Pure-ish + dependency-injected (mirrors `gateway.ts`): `enqueue`, `handleRpc`
 * and `trace` are injectable so the double-gate + identity threading is trivially
 * unit-testable without a live cluster.
 */

/**
 * Legacy `system.yaml`/template tool vocabulary → sanctioned MCP registry names,
 * so existing systems keep working with zero data migration (plan D2). Only these
 * five legacy names map cleanly onto a governed MCP tool; anything else (e.g.
 * `web_fetch`, `knowledge_certify`, bare `connection_*`) stays UNMAPPED and keeps
 * the honest legacy runtime fallback.
 */
export const OS_TOOL_ALIASES: Record<string, string> = {
  retrieve: 'search_knowledge',
  metrics: 'list_metrics',
  files_retrieve: 'search_files',

  write_file: 'upload_file',

  // The four workflow tools were named `*_knowledge`. A system or a model that still uses the old
  // name reaches the workflow tool of the same purpose — and only if that tool is granted
  // (`grants.tools` is migrated on read, see `migrateLegacyWorkflowGrants`). Removed one release later.
  ...DEPRECATED_TOOL_ALIASES,
};

/** #28: which feature flag gates an alias's target (only the ones that
 *  actually depend on one — retrieve's target is always on). */
const ALIAS_REQUIRES_FEATURE: Record<string, string> = {
  metrics: 'metrics',
  author_knowledge: 'workflows',
  index_knowledge: 'workflows',
  publish_knowledge: 'workflows',
  retire_knowledge: 'workflows',
  files_retrieve: 'files',
  write_file: 'files',
};

/** Resolve a single (possibly legacy) grant name to its MCP registry name. */
export function resolveAlias(name: string): string {
  return OS_TOOL_ALIASES[name] ?? name;
}

/**
 * DISCOVERY COMPANIONS — the read-only, governed tools an agent needs to LEARN
 * what to query instead of GUESSING it (#97). Whenever an action tool is granted,
 * its discovery siblings are auto-granted so the agent can list→inspect the exact
 * resource (e.g. the fully-qualified `iceberg.<schema>.<table>`) before acting.
 * Every companion is a read tool (no write-approval hold), stays grant-scoped
 * (added only alongside a tool that was already granted, never blanket), and is
 * still double-gated at execution — so this only widens *discovery*, never authority.
 */
export const DISCOVERY_COMPANIONS: Record<string, string[]> = {
  // Data: to query a table you must first learn its exact FQN + columns.
  query_data: ['list_datasets', 'get_dataset', 'profile_dataset'],
  // Metrics (C4): to evaluate a governed metric you must first learn which members exist
  // and what the member actually means — the semantic-layer-first rule is useless if the
  // model cannot see the members it is told to prefer.
  query_metric: ['list_metrics', 'get_metric', 'get_dataset'],
  // Dashboards (C4): every chart binds a governed metric member, so a dashboard author
  // needs the member list and the view behind it before it can propose a tile.
  create_dashboard: ['list_dashboards', 'list_metrics', 'get_dataset'],
  // Knowledge: browse the catalog before a semantic search.
  search_knowledge: ['list_knowledge'],
  // Files: enumerate/search before reading a specific file.
  get_file: ['list_files', 'search_files'],
  read_app_files: ['list_files', 'search_files'],
};

/**
 * Expand a list of resolved MCP tool names to include their discovery companions,
 * order-preserved and deduped (companions appended after the tool that pulled them
 * in). A companion is added only if the tool that triggers it is present — the
 * expansion never introduces a tool that wasn't earned by an already-granted action
 * tool, so it stays grant-scoped.
 */
export function withDiscoveryCompanions(mcpNames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (n: string) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const name of mcpNames) push(name);
  for (const name of mcpNames) {
    for (const companion of DISCOVERY_COMPANIONS[name] ?? []) push(companion);
  }
  return out;
}

const MCP_NAMES = new Set(ALL_MCP_TOOLS.map((t) => t.name));

/** The read tools that resolve a dataset to a physical medallion FQN — the ones whose
 *  target layer the system's DATA grant selects (get_dataset surfaces it; profile_dataset
 *  profiles it). query_data takes raw SQL, so the layer can only steer it via the FQN the
 *  agent first learns from get_dataset — hence these two carry the enforcement. */
const LAYER_AWARE_DATA_TOOLS = new Set(['get_dataset', 'profile_dataset']);

/**
 * The medallion layer a system's DATA grant selects for a given dataset id, or
 * undefined when the grant is Gold/unset (the serving default). This is the single
 * place the `system.yaml` layer choice is READ at run time.
 */
export function grantedLayerFor(sys: System, datasetId: string): 'bronze' | 'silver' | 'gold' | undefined {
  return sys.grants.data.find((g) => g.id === datasetId)?.layer;
}

// ------------------------------------------------------------- folder grants --

/** A folder-grant kind — the tabs that carry per-item folders (Wave 2/3). */
export type FolderGrantKind = 'data' | 'knowledge' | 'files';
export const FOLDER_GRANT_KINDS: FolderGrantKind[] = ['data', 'knowledge', 'files'];

/** One already-DLS-scoped item the folder-grant kernel resolves against. */
export type ScopedItem = { id: string; folder: string };

/**
 * Loads the OWNER-delegated, already-canView/DLS-scoped item list for `(kind, scope)`
 * — the SAME scoped list the `grants/available` route surfaces. Injected so the pure
 * folder-grant resolution is unit-testable without the server-only stores.
 */
export type ScopedItemsLoader = (
  kind: FolderGrantKind,
  scope: 'personal' | 'domain',
) => Promise<ScopedItem[]>;

/** One folder grant's resolution outcome (for the trace + honesty). */
export type FolderResolution = {
  kind: FolderGrantKind;
  path: string;
  scope: 'personal' | 'domain';
  /** Item ids the grant resolves to (already budget-capped). */
  ids: string[];
  /** Items under the folder BEFORE the budget cap (P) — `ids.length` is M. */
  total: number;
  /** True when the budget cap dropped items (`total > ids.length`). */
  capped: boolean;
};

/**
 * THE RUN/BUILD-TIME FOLDER-GRANT RESOLVER. For each folder grant in data/knowledge/
 * files, load the owner's ALREADY-DLS-scoped item list for `(kind, folder.scope)` and
 * resolve it through the pure kernel `resolveFolderGrant` → the concrete item ids the
 * folder currently covers, capped at `config.folderGrantBudget`. Each id is then fed
 * into the EXISTING per-item grant list (`grants.data` / `grants.knowledge`) at the
 * folder grant's capability — the same path an explicit item grant takes, which the
 * data plane DLS/OPA-checks independently per call. This makes the folder grant SAFE:
 * because `scopedItems` is bounded by what the owner may see, the resolved set can only
 * ever be a SUBSET of the owner's grantable set — a folder grant can never widen access.
 *
 * Late-binding: the live scoped list is read on every call, so an item added under a
 * granted folder is picked up on the NEXT run with no re-save. Files carry no per-item
 * grant list (file tools act over the caller's own DLS), so a files folder grant only
 * contributes to the trace/subset accounting — its per-file access stays live at call
 * time. Pure input → new System; the folder grants themselves are LEFT in place so the
 * next run re-resolves them.
 *
 * Returns the expanded system + the per-grant resolutions (for the "resolved M of P"
 * trace). Budget is `budget ?? config.folderGrantBudget`.
 */
export async function resolveFolderGrants(
  sys: System,
  load: ScopedItemsLoader,
  budget: number = config.folderGrantBudget,
): Promise<{ system: System; resolutions: FolderResolution[] }> {
  const resolutions: FolderResolution[] = [];
  // Shallow-clone the grant lists we may extend (never mutate the input).
  const next: System = {
    ...sys,
    grants: {
      ...sys.grants,
      data: [...sys.grants.data],
      knowledge: [...sys.grants.knowledge],
      files: [...sys.grants.files],
    },
  };

  for (const kind of FOLDER_GRANT_KINDS) {
    const list = next.grants[kind];
    const folderGrants = list.filter((g) => g.folder);
    if (folderGrants.length === 0) continue;
    // Item ids ALREADY granted explicitly (so a folder never double-adds an item).
    const already = new Set(list.filter((g) => !g.folder && g.id).map((g) => g.id));
    for (const g of folderGrants) {
      const folder = g.folder!;
      const scoped = await load(kind, folder.scope);
      const allIds = resolveFolderGrant(folder.path, scoped);
      const capped = allIds.length > budget;
      const ids = capped ? allIds.slice(0, budget) : allIds;
      resolutions.push({ kind, path: folder.path, scope: folder.scope, ids, total: allIds.length, capped });
      // Materialise into the per-item grant list (data/knowledge only — files carry no
      // per-item list). New item grants inherit the folder grant's capability.
      if (kind !== 'files') {
        for (const id of ids) {
          if (already.has(id)) continue;
          already.add(id);
          const grant: ArtifactGrant = { id, capability: g.capability };
          list.push(grant);
        }
      }
    }
  }
  return { system: next, resolutions };
}

/** The Files listing as the loader needs it: the runner's My lane and their Domain lane. */
export type FileLister = (principal: { id: string; domains: string[]; role: CurrentUser['role'] }) => Promise<{
  mine: { id: string; folder: string }[];
  domain: { id: string; folder: string }[];
}>;

/** The real Files store, read as the runner (the same listing the Files tab shows). */
const realFileLister: FileLister = async (principal) => {
  const { listFiles, ensureHydrated } = await import('@tabs/files/lib/store');
  await ensureHydrated();
  return listFiles(principal);
};

/**
 * The REAL, server-backed {@link ScopedItemsLoader}: reads the SAME canView/DLS-scoped
 * lists the `grants/available` route surfaces, as the acting `user`, and projects each
 * item to `{ id, folder }` for the folder kernel. `personal` reads the caller's own
 * lane (`mine`); `domain` reads the shared-in-domain lane. Knowledge is the foldered
 * personal-knowledge notes (a workflow is its own grant kind and has no folder).
 * Never widens: it is exactly the owner-grantable universe, so the kernel's result is
 * provably a subset.
 */
export function serverScopedItemsLoader(user: CurrentUser, deps: { listFiles?: FileLister } = {}): ScopedItemsLoader {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  return async (kind, scope) => {
    if (kind === 'data') {
      const { listDatasets, ensureHydrated } = await import('@tabs/data/lib/store');
      await ensureHydrated();
      const g = listDatasets(principal);
      const group = scope === 'personal' ? g.mine : g.domain;
      return group.map((d) => ({ id: d.id, folder: d.folder }));
    }
    if (kind === 'files') {
      const g = await (deps.listFiles ?? realFileLister)(principal);
      const group = scope === 'personal' ? g.mine : g.domain;
      return group.map((f) => ({ id: f.id, folder: f.folder }));
    }
    // knowledge — the foldered personal-knowledge NOTES. A workflow has no folder and is its own
    // grant kind, so a knowledge folder grant never expands to a `wf_…` id.
    const { listPersonalKnowledge, ensureHydrated: ensurePk } = await import('@tabs/knowledge/lib/personal-store');
    await ensurePk();
    const pk = listPersonalKnowledge(principal);
    const pkGroup = scope === 'personal' ? pk.mine : pk.domain;
    return pkGroup.map((p) => ({ id: p.id, folder: p.folder }));
  };
}

/**
 * Resolve a system's folder grants against the acting user's live scoped lists and
 * mirror a "resolved M of P" note per grant to the Monitoring trace (best-effort; a
 * trace failure never blocks the run). The single governed entry point the run/build
 * seam calls before compiling tools. Returns the expanded system.
 */
export async function resolveFolderGrantsForRun(
  user: CurrentUser,
  sys: System,
  systemId: string,
  deps: Pick<OsToolDeps, 'trace'> = { trace: realTrace },
): Promise<System> {
  return (await resolveFolderGrantsWithWarnings(user, sys, systemId, deps)).system;
}

/**
 * The warnings a run shows its RUNNER about folder grants that matched nothing: "The grant on
 * /invoices in My files currently contains 0 files. 12 files are in Domain files /invoices." —
 * and about a data/knowledge folder grant cut to the folder-grant budget ("first 50 of 80").
 *
 * The pointer to the other lane is computed from the runner's OWN listing (`load` reads as the
 * acting user), and it goes to the run's `warnings` list — the run report a person reads. It is
 * never added to the system prompt or to a tool result: an agent is not told about files outside
 * its grant. A declared output's folder is skipped (empty until the first result is written).
 */
export async function folderGrantWarnings(
  sys: System,
  resolutions: FolderResolution[],
  load: ScopedItemsLoader,
): Promise<string[]> {
  const out: string[] = [];
  const lanes = new Map<string, TreeItemRef[]>();
  const lane = async (kind: FolderGrantKind, scope: 'personal' | 'domain'): Promise<TreeItemRef[]> => {
    const key = `${kind}:${scope}`;
    let rows = lanes.get(key);
    if (!rows) {
      rows = (await load(kind, scope)).map((i) => ({ id: i.id, folder: i.folder, scope }));
      lanes.set(key, rows);
    }
    return rows;
  };
  for (const r of resolutions) {
    // Over the budget: a data/knowledge grant materialises only the first ids (files are checked
    // live per call, so the budget never narrows them). Said on the run AND in the server log.
    if (r.capped && r.kind !== 'files') {
      const text = cappedGrantWarning(r.kind, { path: r.path, scope: r.scope }, r.ids.length, r.total);
      console.warn(`[folder-grant] ${text}`);
      if (!out.includes(text)) out.push(text);
    }
    if (r.total > 0) continue;
    const folder = { path: r.path, scope: r.scope };
    if (isOutputFolder(sys, r.kind, folder)) continue;
    let items: TreeItemRef[] = [];
    try {
      items = [...(await lane(r.kind, 'personal')), ...(await lane(r.kind, 'domain'))];
    } catch {
      /* the pointer is best-effort; the zero itself is already known */
    }
    const cov = folderGrantCoverage(folder, items);
    const text = zeroMatchWarning(r.kind, { ...cov, count: 0 }, 'named');
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** {@link resolveFolderGrantsForRun}, also returning the zero-match warnings for the run report. */
export async function resolveFolderGrantsWithWarnings(
  user: CurrentUser,
  sys: System,
  systemId: string,
  deps: Pick<OsToolDeps, 'trace'> & { load?: ScopedItemsLoader } = { trace: realTrace },
): Promise<{ system: System; warnings: string[] }> {
  // Fast path: no folder grants anywhere ⇒ nothing to resolve (zero store reads).
  const hasFolder =
    sys.grants.data.some((g) => g.folder) ||
    sys.grants.knowledge.some((g) => g.folder) ||
    sys.grants.files.some((g) => g.folder);
  if (!hasFolder) return { system: sys, warnings: [] };

  const load = deps.load ?? serverScopedItemsLoader(user);
  const { system, resolutions } = await resolveFolderGrants(sys, load);
  const warnings = await folderGrantWarnings(sys, resolutions, load);
  const principal = principalFor(systemId);
  for (const r of resolutions) {
    try {
      await deps.trace({
        principal,
        tool: `folder_grant.${r.kind}`,
        input: { path: r.path, scope: r.scope },
        output: { decision: 'allow', resolved: r.ids.length, of: r.total, capped: r.capped },
        decision: 'allow',
      });
    } catch {
      /* attribution is best-effort */
    }
  }
  return { system, warnings };
}

/**
 * The state-modifying MCP tools (the SAME set `lib/agents/tool-catalog.ts` marks
 * `requires_approval`). An agent's call to any of these is HELD for human approval
 * and NEVER auto-executed — the run path's in-process mirror of the Build/OPA
 * `requires_approval` list, so gate 1b needs no live `os-<id>` OPA document. Read
 * tools are absent → they flow through to the run-as-user governed dispatch.
 */
const WRITE_APPROVAL_NAMES = WRITE_TOOL_NAMES;

/** The tab a write tool lands its artifact in — for the honest "wrote N … to My <tab>"
 *  run-report line. Falls back to the tab the write-tool catalog records; an unmapped
 *  write is summarised generically ("My workspace"). */
const WRITE_TOOL_TAB = new Map<string, string>(Object.entries(WRITE_TOOL_TABS));

/** Human labels for the tabs the run report names (keeps "My Data" not "My data"). */
const TAB_LABEL: Record<string, string> = {
  data: 'Data', knowledge: 'Knowledge', files: 'Files', metrics: 'Metrics',
  dashboards: 'Dashboards', connections: 'Connections', software: 'Software',
  agents: 'Agents',
};

/** One run's write accounting — direct My-scope writes vs writes held for approval. */
export type WriteOutcomes = {
  /** Successful DIRECT writes (My-scope, ran without approval), grouped by tab label. */
  wrote: { tab: string; count: number }[];
  /** Total direct writes across all tabs (= sum of `wrote[].count`). */
  wroteTotal: number;
  /** Writes HELD for approval (Domain/Company escalations or read-only blocks). */
  heldTotal: number;
};

/** A run step as the report sees it — the minimal shape both run paths already carry. */
export type RunStepLite = { tool: string; result: string; isError: boolean };

/** True when an errored step's typed envelope carries the `held` (approval) code. */
function isHeldStep(step: RunStepLite): boolean {
  if (!step.isError) return false;
  try {
    const code = (JSON.parse(step.result) as { error?: { code?: string } })?.error?.code;
    return code === 'held';
  } catch {
    return false;
  }
}

/**
 * Count a run's WRITE outcomes DIRECTLY from its executed steps — the honest source
 * for the run report (never inferred). A step is a WRITE iff its (alias-resolved) tool
 * is in {@link WRITE_APPROVAL_NAMES}. It COUNTS as:
 *   • a direct write — the write tool ran without error (a My-scope write executed under
 *     the My-direct rule); grouped by the tab it wrote to; OR
 *   • a held write   — the step errored with the typed `held` code (Domain/Company
 *     escalation or a read-only block enqueued to Governance → Inbox).
 * Non-write tools and non-`held` execution errors are ignored. Pure + deterministic.
 */
export function summarizeWriteOutcomes(steps: RunStepLite[]): WriteOutcomes {
  const byTab = new Map<string, number>();
  let wroteTotal = 0;
  let heldTotal = 0;
  for (const step of steps) {
    const tool = resolveAlias(step.tool);
    if (!WRITE_APPROVAL_NAMES.has(tool)) continue;
    if (isHeldStep(step)) {
      heldTotal += 1;
    } else if (!step.isError) {
      const tab = TAB_LABEL[WRITE_TOOL_TAB.get(tool) ?? ''] ?? 'workspace';
      byTab.set(tab, (byTab.get(tab) ?? 0) + 1);
      wroteTotal += 1;
    }
  }
  const wrote = Array.from(byTab.entries()).map(([tab, count]) => ({ tab, count }));
  return { wrote, wroteTotal, heldTotal };
}

/**
 * The one-line, human run-report sentence for a run's write outcomes — the honest
 * "what changed" surfaced in the Run panel result and the Evaluate per-agent view:
 *   • "Wrote 2 record(s) to My Data, 1 to My Metrics."   (direct My-scope writes)
 *   • "1 write awaiting approval in Governance → Inbox."  (held writes)
 * Both clauses appear when both occurred; an empty run yields '' (no writes to report).
 */
export function writeOutcomesLine(o: WriteOutcomes): string {
  const parts: string[] = [];
  if (o.wroteTotal > 0) {
    const groups = o.wrote.map((g) => `${g.count} to My ${g.tab}`).join(', ');
    parts.push(`Wrote ${o.wroteTotal} record${o.wroteTotal === 1 ? '' : '(s)'} directly — ${groups}.`);
  }
  if (o.heldTotal > 0) {
    parts.push(`${o.heldTotal} write${o.heldTotal === 1 ? '' : 's'} awaiting approval in Governance → Inbox.`);
  }
  return parts.join(' ');
}

/**
 * The hold rule lives in the pure `hold.ts` (no `server-only`) so the LangGraph engine's
 * `tools_<id>` node can compute it BEFORE executing a batch and park the run on an
 * `interrupt()`. Re-exported here unchanged for every existing caller.
 */
export { holdDecision, holdDecisionFor, holdReason, writeTargetScope, type HoldDecision, type WriteScope } from '@tabs/agents/lib/build/hold';


/**
 * Resolve a system's `grants.tools` through the alias map, split into the MCP
 * tools it maps onto (`mcpNames`, deduped, order-preserved) and the leftover
 * `unmapped` legacy names that have no MCP equivalent (→ fallback path).
 */
export function resolveGrantedTools(sys: System): { mcpNames: string[]; unmapped: string[] } {
  const mcpNames: string[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const g of sys.grants.tools) {
    const mapped = resolveAlias(g);
    if (MCP_NAMES.has(mapped)) {
      if (!seen.has(mapped)) {
        seen.add(mapped);
        mcpNames.push(mapped);
      }
    } else {
      unmapped.push(g);
    }
  }
  return { mcpNames: withDiscoveryCompanions(mcpNames), unmapped };
}

/**
 * The granted tool names that resolve to NOTHING in the OS MCP registry (`web_fetch`,
 * `knowledge_certify`, a typo, …). Empty = the system is runnable.
 *
 * A5 replaced the old `isAgenticOsTeam` boolean with this list. The boolean existed to
 * choose between the in-process path and the legacy Python-runtime fallback; there is no
 * fallback any more, so the only honest question left is "which grants have no governed
 * tool behind them" — and the answer belongs in the error message the run doors return,
 * naming the offending tools, rather than in a yes/no that sent the user to another path.
 * `buildGraph` enforces the same rule as a compile error; this is the earlier, friendlier
 * door. A system with NO tool grants is runnable (its agents are plain completions) —
 * under the old boolean it was not, which was an accident of the fallback, not a rule.
 */
export function unmappedGrantNames(sys: System): string[] {
  return resolveGrantedTools(sys).unmapped;
}

/** The `McpTool` objects a system is granted (registry ∩ resolved grants). */
function grantedMcpTools(sys: System): McpTool[] {
  const granted = new Set(resolveGrantedTools(sys).mcpNames);
  // A tool closed to agent runs (`AGENT_FORBIDDEN_TOOLS`) is never ADVERTISED either: a grant that
  // names one is dropped here, so the model is not handed a schema for something gate 0 will
  // refuse. Dropping it from the spec and refusing the call are both needed — a system.yaml can
  // name any tool, and a model will try whatever it can see.
  return ALL_MCP_TOOLS.filter((t) => granted.has(t.name) && !agentForbiddenReason(t.name));
}

/**
 * The governed tools ONE node can be offered, before the runner's role narrows them: the system's
 * granted MCP tools, narrowed to the node's own list (alias-resolved, discovery companions added).
 * The ONE rule behind both {@link grantedToolSpecs} (what a run hands LiteLLM) and the system key's
 * `allowed_tools` (`run-tools.ts`), so the gateway cannot refuse a tool the engine offers.
 */
export function nodeGrantedMcpTools(sys: System, nodeTools?: string[]): McpTool[] {
  const pool = grantedMcpTools(sys);
  if (nodeTools === undefined) return pool;
  if (nodeTools.length === 0) return [];
  // A node granted an action tool (e.g. query_data) also drives its discovery
  // companions (list_datasets/get_dataset/profile_dataset), so it can learn the
  // exact resource before acting — same rule as the system-level grant scope.
  const nodeSet = new Set(withDiscoveryCompanions(nodeTools.map(resolveAlias)));
  return pool.filter((t) => nodeSet.has(t.name));
}

/**
 * The OpenAI-shaped tool schemas to hand LiteLLM for a node: the system's granted
 * MCP tools, role-scoped to the acting user (`listToolsForRole` — an agent can
 * never SEE a tool above its runner's role), optionally narrowed to a node's own
 * `tools` list (also alias-resolved). Same shaping as `runtime.ts` `tabToolSpecs`.
 *
 * `nodeTools` semantics (engine rebuild A0 fix): ABSENT (`undefined`) = inherit every
 * system grant; an explicit EMPTY list = this node drives NO tools. The compiler IR
 * already encodes the distinction (an agent without `tools:` gets the full grant copy,
 * `tools: []` stays `[]`), and the YAML author of `tools: []` — e.g. the Software
 * Delivery Team's orchestrator, "do no building yourself" — means none. Treating `[]`
 * as "inherit" handed those nodes `create_software`/`commit`; the golden fixtures
 * caught it. Matches `toolSpecsFactory` on the software path.
 */
export function grantedToolSpecs(user: CurrentUser, sys: System, nodeTools?: string[]): ToolSpec[] {
  return listToolsForRole(user.role, nodeGrantedMcpTools(sys, nodeTools)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as ToolSpec['inputSchema'],
  }));
}

/**
 * The GRANT-SCOPED tool brief injected into a run's system prompt — a plain-text
 * listing of EXACTLY the tools this system may drive (name + a ONE-LINE summary: the
 * description's first sentence, hard-capped — `tool-brief.ts`; the full description
 * travels once, in the request's `tools` schema, instead of being repeated here),
 * built from the SAME {@link grantedToolSpecs} set advertised to the model. This is
 * the discovery-layer counterpart to the manifest scoping: the prompt can name only
 * granted tools, so the model is never TOLD about a tool (e.g. `create_software`,
 * `build_gold_join`) it cannot call — which is what led it to attempt ungranted
 * tools when the full per-tab CONTEXT.md tool catalog was injected instead.
 *
 * Fail-closed: an empty granted set yields an explicit "no tools" brief (advertise
 * nothing), never a fallback to the whole catalog.
 */
export function grantedToolBrief(user: CurrentUser, sys: System): string {
  const specs = grantedToolSpecs(user, sys);
  if (specs.length === 0) {
    return 'You have been granted NO tools. You cannot take any action — explain this plainly.';
  }
  const lines = specs.map((s) => `- ${s.name} — ${toolSummary(s.description)}`);
  return [
    'You may call ONLY the tools listed here — this is your COMPLETE toolset. Any tool',
    'not on this list is NOT available to you; do not attempt it or reference it as an',
    'option. Consume granted resources by reference via the tools you hold.',
    'Each line is a one-line summary; a tool\'s full description, rules and arguments are',
    'in its own tool definition — read that before you call it.',
    '',
    ...lines,
  ].join('\n');
}

/** Injected collaborators (default to the real governed libs; tests inject spies). */
export type OsToolDeps = {
  /** Governance-queue enqueue for a held (requires_approval) write. */
  enqueue: typeof realEnqueue;
  /** The ONE MCP dispatch — runs the governed lib under the ACTING USER. */
  handleRpc: typeof realHandleRpc;
  /** Best-effort attribution mirror under the system principal (never throws). */
  trace: typeof realTrace;
  /**
   * The two store lookups the resource-grant check needs (where a file lives, which tables a
   * dataset has). Absent → the real stores, read AS THE RUNNING USER ({@link serverGrantResolvers}).
   */
  resolvers?: GrantResolvers;
};

const defaultDeps: OsToolDeps = {
  enqueue: realEnqueue,
  handleRpc: realHandleRpc,
  trace: realTrace,
};

/** A typed, model-readable tool error result (mirrors the MCP `toolError` shape). */
function errorResult(code: string, reason: string): { text: string; isError: boolean } {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/** The typed refusal of a call outside the system's resource grants: `forbidden`, naming kind and id. */
function grantRefusalResult(r: GrantRefusal): { text: string; isError: boolean } {
  return { text: JSON.stringify({ error: { code: r.code, reason: r.reason, ...(r.kind ? { kind: r.kind } : {}), ...(r.id ? { id: r.id } : {}) } }), isError: true };
}

/**
 * The REAL {@link GrantResolvers}: both read the running user's own, already DLS-scoped view, so
 * the resource-grant check can only ever narrow what that user could reach.
 *   - `fileLocations` — the same `listFiles` listing the Files tab shows, with each file's lane.
 *   - `datasetTables` — the physical table of every built layer, through `builtLayerFqn`: the one
 *     governed resolver preview, profile and `get_dataset.queryable` already use. A dataset the
 *     user cannot see resolves to no table.
 */
export function serverGrantResolvers(user: CurrentUser): GrantResolvers {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  return {
    fileLocations: async () => {
      const { listFiles, ensureHydrated } = await import('@tabs/files/lib/store');
      await ensureHydrated();
      const g = listFiles(principal);
      const lane = (rows: { id: string; folder: string }[], l: FileLocation['lane']): FileLocation[] => rows.map((f) => ({ id: f.id, folder: f.folder, lane: l }));
      return [...lane(g.mine, 'personal'), ...lane(g.domain, 'domain'), ...lane(g.marketplace, 'company')];
    },
    datasetTables: async (datasetId) => {
      const { getDataset, builtLayerFqn, ensureHydrated } = await import('@tabs/data/lib/store');
      await ensureHydrated();
      try {
        const d = getDataset(datasetId, principal);
        const out = new Set<string>();
        for (const layer of ['bronze', 'silver', 'gold'] as const) {
          const hit = builtLayerFqn(d, principal, layer);
          if (hit && hit.layer === layer) out.add(hit.fqn);
        }
        return [...out];
      } catch {
        return []; // not visible to the running user (or gone) → it contributes no table
      }
    },
  };
}

/**
 * The governed tool executor an internal agent's tool calls dispatch through. For
 * each `(name, args)` call it enforces the double gate then runs the side effect
 * as the acting user:
 *
 *   1. Grant scope (structural): the alias-resolved tool must be one of the
 *      system's granted MCP tools, else → "Tool not available", NEVER executed.
 *   2. Write-approval hold (in-process): a granted WRITE tool ({@link
 *      WRITE_APPROVAL_NAMES}) → ENQUEUE to Governance and return a typed `held`
 *      result, NEVER executed. Derived from the system's own resolved grant-set +
 *      the write-tool catalog — no live `os-<systemId>` OPA document required, so a
 *      scaffolded system with no prior Build still runs its READ tools.
 *   3. Identity + role floor: a granted READ tool dispatches through
 *      `handleRpc(user, …)` scoped to the granted subset. handleRpc re-checks the
 *      tool's role floor (a creator calling a builder-floor tool gets a typed
 *      `forbidden`) and runs the governed library under `user:<id>` — so the real
 *      side effect is ALWAYS the acting user (its owner DLS clause sees its own
 *      units), and an agent can exceed neither its grants nor its runner's rights.
 *
 * `systemId` is required for the enqueue attribution + trace attribution.
 */
export type ExecutorOptions = {
  /**
   * WHERE the write-approval hold (gate 1b) is decided. `executor` (the default, and what any
   * caller that is not a graph node gets): this executor holds + enqueues and returns the typed
   * `held` result — defence in depth, kept after A5 even though the only production caller now
   * passes `node`. `node` (the LangGraph
   * engine, A2): the `tools_<id>` node has ALREADY computed the hold for the whole batch with the
   * same `holdDecisionFor` rule and parked the run on `interrupt()`; only non-held and APPROVED
   * calls reach this executor, so gate 1b must not re-hold them. Gates 1 and 2 are identical
   * either way — the identity of every side effect stays the acting user.
   */
  holdAt?: 'executor' | 'node';
  /**
   * A3 — the run this executor serves: its governance traces become SPANS of the run's Langfuse
   * trace (id = run id) instead of standalone traces. Threaded here through the deps, never a global.
   */
  traceContext?: RunTraceContext;
  /**
   * Ids this run ALREADY created, per kind — how a resumed run gets back the artifacts it made
   * before it parked (`createdFromSteps` over the checkpointed steps). A fresh run passes nothing.
   */
  createdSeed?: Partial<Record<ResourceKind, string[]>>;
};

/** The agent door for one run: the executor, plus the same resource-grant check asked ahead of time. */
export type AgentToolGate = {
  callTool: ToolExecutor;
  /**
   * Would the resource grants refuse this call? Returns the typed refusal, or null. The engine
   * asks before it holds a write for a person, so nobody is asked to approve a call that would be
   * refused anyway. The executor asks again when it runs the call — this is never the only check.
   */
  precheck: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | null>;
};

export function grantedToolExecutor(
  user: CurrentUser,
  sys: System,
  systemId: string,
  deps: OsToolDeps = defaultDeps,
  opts: ExecutorOptions = {},
): ToolExecutor {
  return agentToolGate(user, sys, systemId, deps, opts).callTool;
}

export function agentToolGate(
  user: CurrentUser,
  sys: System,
  systemId: string,
  deps: OsToolDeps = defaultDeps,
  opts: ExecutorOptions = {},
): AgentToolGate {
  const holdHere = (opts.holdAt ?? 'executor') === 'executor';
  const granted = grantedMcpTools(sys);
  const grantedNames = new Set(granted.map((t) => t.name));
  const sysPrincipal = principalFor(systemId);
  // What an AGENT is shown of a result (never what the tool returns to a person or an external
  // MCP client): `list_files` limited to the system's FILES folder grant(s) and compact, every
  // JSON result without the pretty-printing. See `agent-tool-results.ts`.
  const resultContext: AgentResultContext = {
    filesFolders: sys.grants.files
      .filter((g) => g.capability !== 'Off' && g.capability !== 'Blocked')
      .map((g) => g.folder)
      .filter((f): f is NonNullable<typeof f> => !!f),
  };
  // THE RESOURCE GRANTS of this run: which ids of each kind the agents may touch, plus what the
  // run itself creates. One scope for the whole team; see `grant-scope.ts`.
  const scope = grantScopeOf(sys, opts.createdSeed);
  const resolvers = deps.resolvers ?? serverGrantResolvers(user);

  /**
   * The check, FAIL-CLOSED: when it cannot be made (the file listing or the dataset store did not
   * answer), the call is not run on trust — it is refused with a typed error that says so.
   */
  const scopeVerdict = async (mcpName: string, args: Record<string, unknown>): Promise<GrantVerdict> => {
    try {
      return await checkGrantScope(mcpName, args, scope, resolvers);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { allow: false, refusal: { code: 'forbidden', reason: `${mcpName} was not run: this call could not be checked against the system's resource grants (${why}). Nothing was assumed — try again, and report it if it persists.` } };
    }
  };

  const precheck: AgentToolGate['precheck'] = async (name, args) => {
    const mcpName = resolveAlias(name);
    if (agentForbiddenReason(mcpName) || !grantedNames.has(mcpName)) return null; // gates 0 and 1 answer those
    const verdict = await scopeVerdict(mcpName, args);
    return verdict.allow ? null : grantRefusalResult(verdict.refusal);
  };

  const callTool: ToolExecutor = async (name, args) => {
    const mcpName = resolveAlias(name);
    // A deprecated spelling is still honoured (it runs the current tool through every gate below),
    // and the operator is told once per call so the system can be moved before the name is removed.
    const current = currentToolName(name);
    if (current) logDeprecatedTool(name, current, 'agent', sysPrincipal);

    // Gate 0 — CLOSED TO AGENT RUNS. A few writes are operator acts whose effect is not an
    // artifact in a lane: `reindex_corpus` re-parses and re-embeds a whole tenant corpus. Held
    // would not be enough on its own (the hold can be approved by whoever is watching the inbox,
    // and the run would then fire it), so the agent door refuses outright, with the reason the
    // catalog carries. Checked BEFORE the grant check so the answer is "this is not for agents"
    // rather than a bare "tool not available" — the caller can act on the former.
    const forbidden = agentForbiddenReason(mcpName);
    if (forbidden) {
      await safeTrace(deps, sysPrincipal, mcpName, args, 'deny', forbidden, opts.traceContext);
      return errorResult('forbidden', forbidden);
    }

    // Gate 1 — structural grant scope. Not granted ⇒ never touch OPA or the tool.
    if (!grantedNames.has(mcpName)) {
      // #28: OS_TOOL_ALIASES only — a precise "feature not enabled" message for the
      // 3 legacy aliases whose target is genuinely flag-gated, never guessed for a
      // plain grant/permission denial (that stays the generic message below).
      const requiredFeature = ALIAS_REQUIRES_FEATURE[name];
      if (requiredFeature && !TAB_FEATURES.has(requiredFeature)) {
        return errorResult('not_found', `Tool not available: the '${requiredFeature}' feature is not enabled`);
      }
      // Said in full, so an agent never reads "not available" as "there is nothing there".
      return errorResult(
        'not_found',
        `Tool not available: ${name || '(none)'} is not granted to this system, so it was not run and nothing was read. ` +
          'Use only the tools in your toolset, and say in your answer that this could not be checked.',
      );
    }

    // LAYER ENFORCEMENT — steer a layer-aware data read to the medallion layer the
    // system's DATA grant selected (bronze/silver). The FQN resolution stays SERVER-
    // side (get_dataset/profile_dataset resolve `builtLayerFqn(dataset, layer)` with a
    // graceful not-built fallback); here we only inject the grant's layer when the
    // agent didn't ask for one explicitly. Gold/unset grants inject nothing (the
    // serving default is unchanged — fully backward-compatible).
    if (LAYER_AWARE_DATA_TOOLS.has(mcpName) && args && typeof args === 'object') {
      const a = args as Record<string, unknown>;
      const datasetId = typeof a.datasetId === 'string' ? a.datasetId : '';
      const layer = grantedLayerFor(sys, datasetId);
      if (layer && a.layer === undefined) args = { ...a, layer };
    }

    // Gate 1a — RESOURCE GRANTS. The tool is granted; is the THING it names? A call that targets
    // a dataset, knowledge item, metric, connection, file or plan item outside the system's
    // grants is refused here, before the hold and before the tool: a typed `forbidden` the model
    // can read. Decided in ONE place (`checkGrantScope`) from a declarative map every tool must
    // be in. It only narrows — gate 2 below still runs the call as the acting user.
    const verdict = await scopeVerdict(mcpName, args);
    if (!verdict.allow) {
      await safeTrace(deps, sysPrincipal, mcpName, args, 'deny', verdict.refusal.reason, opts.traceContext);
      return grantRefusalResult(verdict.refusal);
    }

    // Gate 1b — the SCOPE-AWARE Write-approval HOLD, derived IN-PROCESS from the
    // granted set + the write-tool catalog + the write's TARGET scope (no live
    // `os-<systemId>` OPA doc, which only a Build writes). A granted WRITE tool is
    // HELD only when its target crosses a governance boundary:
    //   • PERSONAL (My) write → NOT held (unless read-only): the runner has full
    //     rights to their own My artifact by hand, so their agent does too — it falls
    //     through to gate 2 (the acting user's OPA/DLS/role/ownership is the real
    //     authority), exactly like a read tool.
    //   • DOMAIN write  → held → routed to `domain_admin` approval.
    //   • COMPANY write → held → routed to `admin` (tenant) approval.
    //   • `read-only`   → every write blocked (held), regardless of target.
    // Ownership stays intact: a personal write dispatched at gate 2 runs under
    // `canManageArtifact` (personal → owner-only), so a non-owner is still refused.
    if (holdHere && WRITE_APPROVAL_NAMES.has(mcpName)) {
      const decision = holdDecision(sys.safetyPreset, mcpName);
      if (decision.held) {
        // A held write is NEVER executed — record the human-in-the-loop request,
        // routed to the correct admin for the escalation (domain_admin / admin).
        deps.enqueue({
          kind: 'connection_write',
          title: `Approval needed: ${mcpName}`,
          detail: `System '${systemId}' agent attempted the ${holdReason(mcpName).label} write '${mcpName}' during a run — ${holdReason(mcpName).why}.`,
          agent: sysPrincipal,
          domain: sys.system.domain,
          requestedBy: user.id,
          tool: mcpName,
          approverRole: decision.approverRole,
        });
        await safeTrace(deps, sysPrincipal, mcpName, args, 'requires_approval', undefined, opts.traceContext);
        return errorResult('held', `${mcpName} requires ${decision.approverRole} approval — enqueued to Governance (Domain/Company writes are held)`);
      }
    }

    // Gate 2 — dispatch as the ACTING USER through the ONE governed MCP door. The
    // role floor is re-checked inside handleRpc and the governed lib (OPA/DLS/RLS)
    // is the real authority — never the service principal.
    // The dispatch runs inside the RUN's scope (Part D review L-3): a granted write that commits
    // to a domain repo — an agent system, a dbt project — then carries an `OS-Run-Id` trailer, so
    // the git log distinguishes "a run did this" from "a person did this at the same moment".
    // Nothing else changes: the identity, the grants and the policy are still the acting user's.
    // `list_files` is asked for the WHOLE listing and narrowed afterwards (grant first, then the
    // folder the agent asked for). If the tool narrowed first, an asked-for folder that matches
    // nothing would leave no rows to tell the agent which folders its grant does contain.
    const dispatchArgs =
      mcpName === 'list_files' && args && typeof args === 'object' && 'folder' in (args as Record<string, unknown>)
        ? (({ folder: _asked, ...rest }) => rest)(args as Record<string, unknown>)
        : args;
    const dispatch = () =>
      deps.handleRpc(
        user,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: mcpName, arguments: dispatchArgs } },
        { tools: granted },
      );
    const runId = opts.traceContext?.traceId;
    const res = runId ? await runWithRunId(runId, dispatch) : await dispatch();
    // Honest decision note: a granted WRITE that reached gate 2 is a My-scope write that
    // ran DIRECTLY (the My-direct rule) — record it as such, not a bare 'allow', so the
    // trace tells the truth about WHY no approval was needed.
    const wroteDirectly = WRITE_APPROVAL_NAMES.has(mcpName) && writeTargetScope(mcpName) === 'personal';

    await safeTrace(deps, sysPrincipal, mcpName, args, 'allow', wroteDirectly ? 'allow (own My scope)' : undefined, opts.traceContext);

    // X9: an upstream failure reaches the model as a TYPED envelope (`upstream_error`) like every
    // other refusal, so the graph can route on a code instead of parsing prose. `handleRpc` turns
    // a tool's own exception into a typed MCP tool error, which the `isError` branch below carries
    // through unchanged; this branch is the transport/dispatch error.
    if (res?.error) return errorResult('upstream_error', res.error.message);
    const result = (res?.result ?? {}) as { content?: { text?: string }[]; isError?: boolean };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    if (result.isError || !text) return { text: text || '(no output)', isError: !!result.isError };
    // What the call CREATED is the run's own from here on (read from the raw result).
    verdict.created?.(text);
    // A list or a search comes back narrowed to the granted items — or not at all.
    let shown = text;
    if (verdict.shape) {
      const shaped = verdict.shape(text);
      if ('refusal' in shaped) return grantRefusalResult(shaped.refusal);
      shown = shaped.text;
    }
    return { text: shapeForAgent(mcpName, (args ?? {}) as Record<string, unknown>, shown, resultContext), isError: false };
  };
  return { callTool, precheck };
}

/** Mirror a step under the system principal for Monitoring; never throws. `note`
 *  carries an honest human-readable qualifier (e.g. 'allow (own My scope)' for a
 *  direct My-scope write) surfaced in the trace output alongside the coarse Effect. */
async function safeTrace(
  deps: OsToolDeps,
  principal: string,
  tool: string,
  input: unknown,
  decision: Effect,
  note?: string,
  run?: RunTraceContext,
): Promise<void> {
  try {
    await deps.trace({ principal, tool, input, output: { decision: note ?? decision }, decision, run });
  } catch {
    /* attribution is best-effort — the governed lib already traced under the user */
  }
}
