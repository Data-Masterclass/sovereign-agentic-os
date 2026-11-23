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
import { checkGrantAccess, type GrantCheckKind, type GrantProbe, type GrantWarning, type ProbeResult } from '@tabs/agents/lib/grant-access';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';

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

/** The grant warnings for a parsed system, as `user`. Never throws (a warning must never break a save). */
export async function grantWarningsFor(user: CurrentUser, sys: System, deps: { handleRpc?: typeof realHandleRpc } = {}): Promise<GrantWarning[]> {
  try {
    return await checkGrantAccess(user, sys, governedGrantProbe(user, deps));
  } catch {
    return [];
  }
}

/**
 * The warnings for ONE grant kind, probing only item ids NOT in `skipIds` — the grant picker
 * passes the ids its (already canView-filtered) feed returned, so a grant the picker can show
 * is never probed again. Folder grants of the kind are always classified.
 */
export async function grantWarningsForKind(
  user: CurrentUser,
  sys: System,
  kind: GrantCheckKind,
  skipIds: ReadonlySet<string>,
  deps: { handleRpc?: typeof realHandleRpc } = {},
): Promise<GrantWarning[]> {
  const only: System = {
    ...sys,
    grants: {
      data: [], knowledge: [], metrics: [], tools: [], connections: [], files: [], workflows: [], plan: [],
      [kind]: (sys.grants[kind] ?? []).filter((g) => g.folder || !skipIds.has(g.id)),
    },
  };
  return grantWarningsFor(user, only, deps);
}

/** {@link grantWarningsFor} over a system.yaml text; an unparsable yaml yields no warnings. */
export async function grantWarningsForYaml(user: CurrentUser, yaml: string, deps: { handleRpc?: typeof realHandleRpc } = {}): Promise<GrantWarning[]> {
  let sys: System;
  try {
    sys = parseSystem(yaml);
  } catch {
    return [];
  }
  return grantWarningsFor(user, sys, deps);
}
