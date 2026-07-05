/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import {
  ALL_MCP_TOOLS,
  handleRpc as realHandleRpc,
  listToolsForRole,
  type McpTool,
} from '@/lib/mcp/server';
import type { ToolExecutor, ToolSpec } from '@/lib/assistant/agentic';
import type { System } from '../system-schema.ts';
import { type Effect } from '../gateway.ts';
import { principalFor } from './runtime-contract.ts';
import { authorize as realAuthorize, trace as realTrace, type ToolName } from '@/lib/agent-governed';
import { enqueue as realEnqueue } from '@/lib/approvals';

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
 *      through the legacy→MCP alias map) AND authorized for the SYSTEM principal
 *      `os-<systemId>` by OPA. This is where a Write-approval tool is HELD: a
 *      `requires_approval` effect enqueues to Governance and NEVER executes.
 *   2. Role floor + governed authority — the actual call runs through
 *      `handleRpc(user, …)`, which re-checks the tool's role floor (`server.ts`)
 *      and runs the governed library under `user:<id>` + domains (OPA/DLS/RLS).
 *      The USER is always the identity of the real side effect — never the service
 *      principal `os-<systemId>`.
 *
 * The gates are an INTERSECTION: a tool passes only if BOTH the system grant and
 * the user's role/OPA allow it. Neither can broaden the other.
 *
 * Pure-ish + dependency-injected (mirrors `gateway.ts`): `authorize`, `enqueue`,
 * `handleRpc` and `trace` are injectable so the double-gate + identity threading
 * is trivially unit-testable without a live cluster.
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

const MCP_NAMES = new Set(ALL_MCP_TOOLS.map((t) => t.name));

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
  return { mcpNames, unmapped };
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
    const nodeSet = new Set(nodeTools.map(resolveAlias));
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
  /** OPA gate for the SYSTEM principal `os-<id>` (grant scope + Write-approval holds). */
  authorize: (principal: string, tool: string) => Promise<{ effect: Effect; reason: string }>;
  /** Governance-queue enqueue for a held (requires_approval) write. */
  enqueue: typeof realEnqueue;
  /** The ONE MCP dispatch — runs the governed lib under the ACTING USER. */
  handleRpc: typeof realHandleRpc;
  /** Best-effort attribution mirror under the system principal (never throws). */
  trace: typeof realTrace;
};

const defaultDeps: OsToolDeps = {
  authorize: (principal, tool) => realAuthorize(principal, tool as ToolName),
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
 *   2. Grant scope (OPA, `os-<systemId>` principal): `deny` → typed forbidden,
 *      never executed; `requires_approval` → ENQUEUE to Governance and return a
 *      typed `held` result, never executed.
 *   3. Identity + role floor: dispatch through `handleRpc(user, …)` scoped to the
 *      granted subset. handleRpc re-checks the tool's role floor (a creator calling
 *      a builder-floor tool gets a typed `forbidden`) and runs the governed library
 *      under `user:<id>` — so the real side effect is ALWAYS the acting user, and an
 *      agent can exceed neither its grants nor its runner's rights.
 *
 * `systemId` is required for the `os-<id>` OPA pre-gate + trace attribution.
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

    // Gate 1b — OPA on the SYSTEM principal (grant scope + Write-approval holds).
    const decision = await deps.authorize(sysPrincipal, mcpName);
    if (decision.effect === 'requires_approval') {
      // A held write is NEVER executed — record the human-in-the-loop request.
      deps.enqueue({
        kind: 'connection_write',
        title: `Approval needed: ${mcpName}`,
        detail: `System '${systemId}' agent attempted a write-approval tool '${mcpName}' during a run.`,
        agent: sysPrincipal,
        domain: sys.system.domain,
        requestedBy: user.id,
        tool: mcpName,
      });
      await safeTrace(deps, sysPrincipal, mcpName, args, decision.effect);
      return errorResult('held', `${mcpName} requires approval — enqueued to Governance (${decision.reason})`);
    }
    if (decision.effect !== 'allow') {
      await safeTrace(deps, sysPrincipal, mcpName, args, decision.effect);
      return errorResult('forbidden', `${sysPrincipal} is not granted ${mcpName} (${decision.reason})`);
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
