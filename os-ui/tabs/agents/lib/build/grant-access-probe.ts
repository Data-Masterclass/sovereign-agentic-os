/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Resolve a granted id as the acting user — the server half of `grant-access.ts`
 * USER STORY: As a builder saving or building a team I want each granted id checked with exactly
 *             the visibility rule the team will meet when it runs as me.
 * ARCHITECTURE:
 *   - Same door as `grant-presence.ts`: each id is read with the kind's own `get_*` tool through
 *     `handleRpc(user, …)` — the identity, canView/DLS rule and typed errors an agent's own call
 *     would get, and no import of another tab's store (a tab may not import another tab). The
 *     tab answers 403 → `forbidden` for an id that exists but is not visible to the caller and
 *     404 → `not_found` for one that does not exist.
 *   - Only a VISIBLE item's body is read, and only its home `domain` and whether it is a
 *     marketplace (company-certified) item. Nothing about an unseeable item is ever read.
 *   - Anything else (an outage, an unreadable answer) is `unknown`: the check says nothing.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc as realHandleRpc, type JsonRpcResponse } from '@core/mcp/server';
import { checkGrantAccessReport, type GrantCheckKind, type GrantProbe, type GrantWarning, type ProbeResult } from '@tabs/agents/lib/grant-access';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { registerGrantCheckPort } from '@core/kernel/grant-check-port';

const READ: Record<GrantCheckKind, { tool: string; arg: string }> = {
  data: { tool: 'get_dataset', arg: 'datasetId' },
  files: { tool: 'get_file', arg: 'fileId' },
  knowledge: { tool: 'get_knowledge', arg: 'id' },
  workflows: { tool: 'get_workflow', arg: 'workflowId' },
  metrics: { tool: 'get_metric', arg: 'metricId' },
  connections: { tool: 'get_connection', arg: 'connId' },
};

/** Tier/visibility spellings across the tabs that mean "company-certified / marketplace". */
const MARKETPLACE = new Set(['product', 'certified', 'marketplace', 'company']);

type ToolResult = { isError?: boolean; content?: { text?: string }[]; structuredContent?: { error?: { code?: string } } };

/** Read a `tools/call` answer into a {@link ProbeResult}. Exported for the unit test. */
export function readProbeAnswer(res: unknown): ProbeResult {
  const r = (res as JsonRpcResponse | null)?.result as ToolResult | undefined;
  if (!r) return { status: 'unknown' };
  if (r.isError) {
    const code = r.structuredContent?.error?.code;
    if (code === 'forbidden') return { status: 'forbidden' };
    if (code === 'not_found') return { status: 'not_found' };
    return { status: 'unknown' };
  }
  try {
    const body = JSON.parse(r.content?.[0]?.text ?? '') as Record<string, unknown>;
    const domain = typeof body.domain === 'string' ? body.domain : null;
    const marks = [body.tier, body.scope, body.visibility].filter((v): v is string => typeof v === 'string');
    return { status: 'visible', domain, marketplace: marks.some((m) => MARKETPLACE.has(m.toLowerCase())) };
  } catch {
    // Visible, but the body is not JSON we can read: treat as in-scope rather than guess.
    return { status: 'visible' };
  }
}

/** The governed-door probe for one acting user. */
export function governedGrantProbe(user: CurrentUser, deps: { handleRpc?: typeof realHandleRpc } = {}): GrantProbe {
  const call = deps.handleRpc ?? realHandleRpc;
  return async (kind, id) => {
    const { tool, arg } = READ[kind];
    const res = await call(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { [arg]: id } } });
    return readProbeAnswer(res);
  };
}

/**
 * Either the check ran, or it did not — and why. A save is never blocked by the check, but a
 * failure is never dressed up as "no warnings" either: callers surface `reason`.
 */
export type GrantCheckResult =
  | { checked: true; warnings: GrantWarning[] }
  | { checked: false; warnings: GrantWarning[]; reason: string };

function notRun(reason: string): GrantCheckResult {
  return { checked: false, warnings: [], reason };
}

/** The grant check for a parsed system, as `user`. Never throws. */
export async function grantWarningsFor(user: CurrentUser, sys: System, deps: { handleRpc?: typeof realHandleRpc; deadlineMs?: number } = {}): Promise<GrantCheckResult> {
  try {
    const r = await checkGrantAccessReport(user, sys, governedGrantProbe(user, deps), { deadlineMs: deps.deadlineMs });
    const unchecked = r.timedOut + r.unknown;
    if (unchecked > 0) {
      // Partial answers are kept, but this is NOT an all-clear: say how many could not be checked.
      const why = [r.timedOut ? `${r.timedOut} timed out` : '', r.unknown ? `${r.unknown} got no readable answer (outage)` : ''].filter(Boolean).join(', ');
      return { checked: false, warnings: r.warnings, reason: `${unchecked} of ${r.probed} grants could not be checked (${why})` };
    }
    return { checked: true, warnings: r.warnings };
  } catch (e) {
    return notRun(`grant check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The check for ONE grant kind, probing only item ids NOT in `skipIds` — the grant picker
 * passes the ids its (already canView-filtered) feed returned, so a grant the picker can show
 * is never probed again. Folder grants of the kind are always classified.
 */
export async function grantWarningsForKind(
  user: CurrentUser,
  sys: System,
  kind: GrantCheckKind,
  skipIds: ReadonlySet<string>,
  deps: { handleRpc?: typeof realHandleRpc } = {},
): Promise<GrantCheckResult> {
  const only: System = {
    ...sys,
    grants: {
      data: [], knowledge: [], metrics: [], tools: [], connections: [], files: [], workflows: [], plan: [],
      [kind]: (sys.grants[kind] ?? []).filter((g) => g.folder || !skipIds.has(g.id)),
    },
  };
  return grantWarningsFor(user, only, deps);
}

/** {@link grantWarningsFor} over a system.yaml text. Never throws. */
export async function grantWarningsForYaml(user: CurrentUser, yaml: string, deps: { handleRpc?: typeof realHandleRpc } = {}): Promise<GrantCheckResult> {
  let sys: System;
  try {
    sys = parseSystem(yaml);
  } catch (e) {
    return notRun(`grant check skipped: system.yaml does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  return grantWarningsFor(user, sys, deps);
}

/** Install this check into the kernel's port, so kernel code (the MCP agent tools) can run it
 *  without importing this tab. Called at boot from `instrumentation.ts`. */
export function registerGrantCheck(): void {
  registerGrantCheckPort({ forYaml: (user, yaml) => grantWarningsForYaml(user, yaml) });
}
