/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import {
  ALL_MCP_TOOLS,
  handleRpc as realHandleRpc,
  listToolsForRole,
  type McpTool,
} from '@/lib/mcp/server';
import { ALL_WRITE_TOOLS } from '@/lib/mcp/write-tools';
import type { ToolExecutor, ToolSpec } from '@/lib/assistant/agentic';
import type { ArtifactGrant, System, SafetyPreset } from '../system-schema.ts';
import { type Effect } from '../gateway.ts';
import { principalFor } from './runtime-contract.ts';
import { trace as realTrace } from '@/lib/infra/agent-governed';
import { enqueue as realEnqueue } from '@/lib/governance/approvals';
import { resolveFolderGrant } from '@/lib/core/folders';
import { config } from '@/lib/core/config';

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
 *      a granted write tool (any {@link ALL_WRITE_TOOLS} name) resolves to
 *      `requires_approval`, enqueues to Governance and NEVER executes; a granted
 *      read tool is allowed to reach gate 2. This decision is derived IN-PROCESS
 *      from the system's own resolved grant-set + the write-tool catalog — it does
 *      NOT depend on a live `os-<systemId>` OPA document (which only a Build writes),
 *      so a scaffolded system runs correctly with no prior Build.
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
  predict: 'science_predict',
  write_file: 'upload_file',
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

/**
 * The REAL, server-backed {@link ScopedItemsLoader}: reads the SAME canView/DLS-scoped
 * lists the `grants/available` route surfaces, as the acting `user`, and projects each
 * item to `{ id, folder }` for the folder kernel. `personal` reads the caller's own
 * lane (`mine`); `domain` reads the shared-in-domain lane. Knowledge folds BOTH the
 * workflow catalog (no folders → root) and the foldered personal-knowledge entries.
 * Never widens: it is exactly the owner-grantable universe, so the kernel's result is
 * provably a subset.
 */
export function serverScopedItemsLoader(user: CurrentUser): ScopedItemsLoader {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  return async (kind, scope) => {
    if (kind === 'data') {
      const { listDatasets, ensureHydrated } = await import('@/lib/data/store');
      await ensureHydrated();
      const g = listDatasets(principal);
      const group = scope === 'personal' ? g.mine : g.domain;
      return group.map((d) => ({ id: d.id, folder: d.folder }));
    }
    if (kind === 'files') {
      const { listFiles, ensureHydrated } = await import('@/lib/files/store');
      await ensureHydrated();
      const g = listFiles(principal);
      const group = scope === 'personal' ? g.mine : g.domain;
      return group.map((f) => ({ id: f.id, folder: f.folder }));
    }
    // knowledge — workflows (no folder → root) ∪ foldered personal-knowledge entries.
    const [{ listWorkflows, ensureHydrated: ensureWf }, { listPersonalKnowledge, ensureHydrated: ensurePk }] =
      await Promise.all([import('@/lib/knowledge/store'), import('@/lib/knowledge/personal-store')]);
    await Promise.all([ensureWf(), ensurePk()]);
    const wf = listWorkflows(principal);
    const pk = listPersonalKnowledge(principal);
    const wfGroup = scope === 'personal' ? wf.mine : wf.domain;
    const pkGroup = scope === 'personal' ? pk.mine : pk.domain;
    return [
      ...wfGroup.map((w) => ({ id: w.id, folder: '/' })),
      ...pkGroup.map((p) => ({ id: p.id, folder: p.folder })),
    ];
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
  // Fast path: no folder grants anywhere ⇒ nothing to resolve (zero store reads).
  const hasFolder =
    sys.grants.data.some((g) => g.folder) ||
    sys.grants.knowledge.some((g) => g.folder) ||
    sys.grants.files.some((g) => g.folder);
  if (!hasFolder) return sys;

  const { system, resolutions } = await resolveFolderGrants(sys, serverScopedItemsLoader(user));
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
  return system;
}

/**
 * The state-modifying MCP tools (the SAME set `lib/agents/tool-catalog.ts` marks
 * `requires_approval`). An agent's call to any of these is HELD for human approval
 * and NEVER auto-executed — the run path's in-process mirror of the Build/OPA
 * `requires_approval` list, so gate 1b needs no live `os-<id>` OPA document. Read
 * tools are absent → they flow through to the run-as-user governed dispatch.
 */
const WRITE_APPROVAL_NAMES = new Set(ALL_WRITE_TOOLS.map((t) => t.name));

/**
 * Does the system's safety preset HOLD writes for human approval? Mirrors
 * `lib/governance/governance.ts` `resolveAutonomous` for the agent-run path:
 *   - `read-only`    → writes blocked + queued (held).
 *   - `read-propose` → writes drafted for a human to run (held).
 *   - `read-bounded` → bounded writes auto-run (NOT held) — gate 2 (the acting
 *                      user's OPA/DLS/role) is the real authority.
 *   - `full-in-scope`→ everything the grants expose runs (NOT held).
 * When NOT held, a granted write tool falls through to the run-as-user governed
 * dispatch, exactly like a read tool: an agent can still never exceed what its
 * runner could do by hand in the UI (creating a Personal-lane artifact needs no
 * approval), and promotion (Personal→Shared) keeps its own separate approval gate.
 *
 * SUPERSEDED by the SCOPE-AWARE {@link holdDecision}: the old blanket rule held EVERY
 * agent write under read-only/read-propose regardless of the write's TARGET scope, so
 * an agent creating a PERSONAL (My) artifact — a My-lane write its builder has full
 * rights to by hand — was wrongly queued for admin review. Kept only for `read-only`,
 * which still blocks all writes. New writes route through `holdDecision`.
 */
export function writesAreHeld(preset: SafetyPreset): boolean {
  return preset === 'read-only';
}

/**
 * The TARGET SCOPE of a write — the lane the artifact lands in. This is what makes
 * the hold SCOPE-AWARE: a `personal` (My) write is exactly what the runner could do
 * by hand with NO approval, so it is never held; a `domain` / `company` write is a
 * governance ESCALATION (My→Domain / Domain→Company) and IS held to the right admin.
 */
export type WriteScope = 'personal' | 'domain' | 'company';

/**
 * The ESCALATING write tools — the promotion / publish / certify / approve family
 * whose EFFECT crosses a governance boundary (My→Domain or Domain→Company). These
 * are the ONLY writes an agent (or its builder by hand) may not perform directly:
 * they are HELD to the correct admin. Everything else in {@link WRITE_APPROVAL_NAMES}
 * is a create/author/upload/build/document/update on a PERSONAL (My) artifact — the
 * runner's own work — and is NOT held.
 *
 *   - `publish_knowledge`  — flips a workflow My→Domain (domain_admin gate).
 *   - `request_promotion`  — files a My→Domain promotion request (domain_admin).
 *   - `approve_promotion`  — APPLIES a Domain promotion (domain_admin).
 *   - `promote_pillar`     — raises a pillar one tier (Domain needs Builder+, Company
 *                            Admin; conservatively routed to domain_admin — the
 *                            in-lib canPromotePillar re-checks the Company->Admin gate).
 *
 * `create_pillar` / `update_pillar` are scope-parametric (a `scope` arg can select
 * Domain/Company); their target is resolved per-call in {@link writeTargetScope}.
 */
const ESCALATING_DOMAIN_TOOLS = new Set(['publish_knowledge', 'request_promotion', 'approve_promotion', 'promote_pillar']);

/**
 * The scope a scope-parametric write tool selects via its `scope` arg (e.g.
 * `create_pillar {scope:'domain'|'tenant'}`). `tenant`/`company` -> Company; `domain`
 * -> Domain; `personal` -> Personal; absent/unknown -> undefined (caller defaults to My).
 */
function scopeFromArgs(args: unknown): WriteScope | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const raw = (args as Record<string, unknown>).scope;
  if (raw === 'tenant' || raw === 'company') return 'company';
  if (raw === 'domain') return 'domain';
  if (raw === 'personal') return 'personal';
  return undefined;
}

/**
 * The TARGET SCOPE of a granted write tool call. Conservative + fail-closed:
 *   - a scope-parametric tool (create_pillar/update_pillar) reads its `scope` arg —
 *     `domain` -> Domain, `tenant` -> Company, else Personal (the create default);
 *   - the escalation family (promote/publish/approve) -> Domain (the My->Domain gate);
 *   - everything else (create_/ingest_/author_/upload_/build_/transform_/document_/
 *     define_/attach_/wire_/update_/archive_ ... on a My artifact) -> Personal.
 * A write only crosses a governance boundary when THIS says Domain/Company, so a
 * personal create is never held.
 */
export function writeTargetScope(mcpName: string, args?: unknown): WriteScope {
  // Scope-parametric create/update: the arg picks the lane (My-default).
  if (mcpName === 'create_pillar' || mcpName === 'update_pillar') {
    return scopeFromArgs(args) ?? 'personal';
  }
  if (ESCALATING_DOMAIN_TOOLS.has(mcpName)) return 'domain';
  return 'personal';
}

/**
 * SCOPE-AWARE hold: does a granted WRITE tool call cross a governance boundary that
 * must be HELD for admin approval? The scope-aware replacement for the old blanket
 * preset hold — the personal-create path is NEVER held.
 *
 *   - `read-only`                -> ALL writes blocked + queued (held to admin).
 *   - any other preset, PERSONAL -> NOT held. Falls through to the run-as-user
 *                                   governed dispatch (gate 2 = the acting user's
 *                                   OPA/DLS/role/ownership is the real authority; a
 *                                   builder has FULL rights to their own My artifact,
 *                                   so their agent does too — never more).
 *   - any other preset, DOMAIN   -> held -> routed to `domain_admin` approval.
 *   - any other preset, COMPANY  -> held -> routed to `admin` (tenant) approval.
 *
 * The security invariant: an agent NEVER exceeds what its runner could do by hand.
 * A personal write needs no approval by hand, so it is not held; a Domain/Company
 * write is an escalation the runner could NOT do by hand (it needs an admin), so it
 * is held to that admin. Fail-closed: an unknown scope resolves to `personal` only
 * for non-escalating create tools (the runner's own work); the escalation family and
 * any Domain/Company target are always held.
 */
export function holdDecision(
  preset: SafetyPreset,
  mcpName: string,
  args?: unknown,
): { held: false } | { held: true; approverRole: 'domain_admin' | 'admin' } {
  // read-only blocks every write, regardless of target.
  if (preset === 'read-only') return { held: true, approverRole: 'admin' };
  const scope = writeTargetScope(mcpName, args);
  if (scope === 'company') return { held: true, approverRole: 'admin' };
  if (scope === 'domain') return { held: true, approverRole: 'domain_admin' };
  // personal -> never held (the create default): gate 2 is the authority.
  return { held: false };
}

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
 * Is this a system whose grants resolve entirely to the OS MCP registry? Such a
 * system runs the in-process, run-as-user governed path (T4). It REPLACES the old
 * `isAgenticSoftwareTeam` gate — software-only teams are a strict subset (their
 * tools are already MCP names), so their existing behaviour is preserved, while
 * mixed data/knowledge grants now qualify too. A `hermes` runtime or ANY unmapped
 * legacy tool (`web_fetch`, …) → false, keeping the honest legacy fallback.
 */
export function isAgenticOsTeam(sys: System): boolean {
  if (sys.runtime !== 'langgraph') return false;
  if (sys.grants.tools.length === 0) return false;
  return resolveGrantedTools(sys).unmapped.length === 0;
}

/** The `McpTool` objects a system is granted (registry ∩ resolved grants). */
function grantedMcpTools(sys: System): McpTool[] {
  const granted = new Set(resolveGrantedTools(sys).mcpNames);
  return ALL_MCP_TOOLS.filter((t) => granted.has(t.name));
}

/**
 * The OpenAI-shaped tool schemas to hand LiteLLM for a node: the system's granted
 * MCP tools, role-scoped to the acting user (`listToolsForRole` — an agent can
 * never SEE a tool above its runner's role), optionally narrowed to a node's own
 * `tools` list (also alias-resolved). Same shaping as `runtime.ts` `tabToolSpecs`.
 */
export function grantedToolSpecs(user: CurrentUser, sys: System, nodeTools?: string[]): ToolSpec[] {
  let pool = grantedMcpTools(sys);
  if (nodeTools && nodeTools.length > 0) {
    // A node granted an action tool (e.g. query_data) also drives its discovery
    // companions (list_datasets/get_dataset/profile_dataset), so it can learn the
    // exact resource before acting — same rule as the system-level grant scope.
    const nodeSet = new Set(withDiscoveryCompanions(nodeTools.map(resolveAlias)));
    pool = pool.filter((t) => nodeSet.has(t.name));
  }
  return listToolsForRole(user.role, pool).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as ToolSpec['inputSchema'],
  }));
}

/** Injected collaborators (default to the real governed libs; tests inject spies). */
export type OsToolDeps = {
  /** Governance-queue enqueue for a held (requires_approval) write. */
  enqueue: typeof realEnqueue;
  /** The ONE MCP dispatch — runs the governed lib under the ACTING USER. */
  handleRpc: typeof realHandleRpc;
  /** Best-effort attribution mirror under the system principal (never throws). */
  trace: typeof realTrace;
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
export function grantedToolExecutor(
  user: CurrentUser,
  sys: System,
  systemId: string,
  deps: OsToolDeps = defaultDeps,
): ToolExecutor {
  const granted = grantedMcpTools(sys);
  const grantedNames = new Set(granted.map((t) => t.name));
  const sysPrincipal = principalFor(systemId);

  return async (name, args) => {
    const mcpName = resolveAlias(name);

    // Gate 1 — structural grant scope. Not granted ⇒ never touch OPA or the tool.
    if (!grantedNames.has(mcpName)) {
      return errorResult('not_found', `Tool not available: ${name || '(none)'}`);
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
    if (WRITE_APPROVAL_NAMES.has(mcpName)) {
      const decision = holdDecision(sys.safetyPreset, mcpName, args);
      if (decision.held) {
        // A held write is NEVER executed — record the human-in-the-loop request,
        // routed to the correct admin for the escalation (domain_admin / admin).
        deps.enqueue({
          kind: 'connection_write',
          title: `Approval needed: ${mcpName}`,
          detail: `System '${systemId}' agent attempted a ${writeTargetScope(mcpName, args)}-scope write '${mcpName}' during a run — Domain/Company writes are held for admin approval.`,
          agent: sysPrincipal,
          domain: sys.system.domain,
          requestedBy: user.id,
          tool: mcpName,
          approverRole: decision.approverRole,
        });
        await safeTrace(deps, sysPrincipal, mcpName, args, 'requires_approval');
        return errorResult('held', `${mcpName} requires ${decision.approverRole} approval — enqueued to Governance (Domain/Company writes are held)`);
      }
    }

    // Gate 2 — dispatch as the ACTING USER through the ONE governed MCP door. The
    // role floor is re-checked inside handleRpc and the governed lib (OPA/DLS/RLS)
    // is the real authority — never the service principal.
    const res = await deps.handleRpc(
      user,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: mcpName, arguments: args } },
      { tools: granted },
    );
    await safeTrace(deps, sysPrincipal, mcpName, args, 'allow');

    if (res?.error) return { text: `Error: ${res.error.message}`, isError: true };
    const result = (res?.result ?? {}) as { content?: { text?: string }[]; isError?: boolean };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    return { text: text || '(no output)', isError: !!result.isError };
  };
}

/** Mirror a step under the system principal for Monitoring; never throws. */
async function safeTrace(
  deps: OsToolDeps,
  principal: string,
  tool: string,
  input: unknown,
  decision: Effect,
): Promise<void> {
  try {
    await deps.trace({ principal, tool, input, output: { decision }, decision });
  } catch {
    /* attribution is best-effort — the governed lib already traced under the user */
  }
}
