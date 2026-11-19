/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    An app starts the agent systems it was granted through its own tool door
 * USER STORY: As the owner of an app I grant it an agent system in Choose Context → Agents. The
 *             app's tool door (`POST /api/apps/[id]/tool`) then offers `run_agent_system` and
 *             `list_agent_systems`; calling them starts that agent as the signed-in user, or lists
 *             it, and never reaches an agent the app was not given.
 * ARCHITECTURE:
 *   - The agents grant compiles both tools into the app's capability profile (`grant-tools.ts`
 *     `agentToolsFromGrants`). Before this module, the door treated them like the app's own
 *     tools: `run_agent_system` is a write, so it was held for approval, and the shared executor
 *     (`app-records.ts executeAppTool`) only knows record tools and the app's own OpenAPI
 *     operations — so neither tool could ever reach an agent.
 *   - These two names are answered HERE, by the OS's own MCP tools of the same name, dispatched
 *     through `handleRpc` as the signed-in user (injected by the route as `rpc`, since a tab may
 *     not import the MCP server's tab-owned tools). So the user's role floor, run rights
 *     (`getSystemForRun`), the agent's own grants and its own write holds all apply unchanged.
 *   - The app's own rule sits in front: the tool must be in the app's compiled profile (not
 *     blocked), and the system id must be on the app's agents grant. Same rule as the SDK's
 *     `os.agents.run` door.
 *   - Starting the run is not held for approval at this door, matching `os.agents.run`: what the
 *     agent then does is governed by the agent's own holds.
 */
import { authorizeConnectionCall, trace } from '@core/infra/agent-governed';
import { isAgentGranted, normalizeAgentGrants, type AppAgentGrant } from '@tabs/software/lib/app-agent-grants';

/** The tool names this door answers instead of the app's own executor. */
export const APP_AGENT_TOOLS: ReadonlySet<string> = new Set(['run_agent_system', 'list_agent_systems']);

/** One MCP `tools/call` as the signed-in user: the text it returned, or its error. */
export type AppAgentRpc = (tool: string, args: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; message: string; code?: string }>;

export type AppAgentDoorResult = { status: number; body: Record<string, unknown> };

type DoorApp = { id: string; name: string; mcpPrincipal: string; agents?: AppAgentGrant[] };

const STATUS_BY_CODE: Record<string, number> = { forbidden: 403, not_found: 404, bad_request: 400, conflict: 409 };

function systemIdOf(args: Record<string, unknown>): string {
  for (const k of ['systemId', 'id', 'system']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** A JSON tool result, or the raw text when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callAppAgentTool(
  app: DoorApp,
  tool: string,
  args: Record<string, unknown> | undefined,
  rpc: AppAgentRpc,
): Promise<AppAgentDoorResult> {
  const principal = app.mcpPrincipal;
  const input = args ?? {};
  const deny = async (status: number, reason: string, layer: string) => {
    const tr = await trace({ principal, tool, input, output: { denied: reason, layer }, decision: 'deny' });
    return { status, body: { tool, principal, decision: 'deny', policy: 'app-grant', layer, reason, traceId: tr.id } };
  };

  // The app's compiled profile must expose the tool (it does only while an agent is granted) and
  // must not have it switched off.
  const profile = authorizeConnectionCall(principal, tool, input);
  if (profile.effect === 'deny') {
    return deny(403, `the app '${app.name}' has no agent systems it may use (${profile.reason}). Its owner can grant one in the app's Choose Context step, under Agents.`, 'profile');
  }
  const grants = normalizeAgentGrants(app.agents);

  if (tool === 'list_agent_systems') {
    const systems: Record<string, unknown>[] = [];
    for (const g of grants) {
      const r = await rpc('get_agent_system', { systemId: g.id });
      if (r.ok) {
        const v = parsed(r.text) as { system?: { name?: string; system?: { name?: string } }; name?: string };
        systems.push({ id: g.id, name: v?.name ?? v?.system?.name ?? v?.system?.system?.name ?? g.id, available: true });
      } else {
        systems.push({ id: g.id, available: false, reason: r.message });
      }
    }
    const tr = await trace({ principal, tool, input, output: { systems: systems.length }, decision: 'allow' });
    return { status: 200, body: { tool, principal, decision: 'allow', policy: 'app-grant', traceId: tr.id, result: { systems } } };
  }

  // run_agent_system
  const systemId = systemIdOf(input);
  if (!systemId) return deny(400, 'run_agent_system needs the `systemId` of an agent system this app was granted.', 'args');
  if (!isAgentGranted(grants, systemId)) {
    return deny(403, `the app '${app.name}' was not granted the agent system ${systemId}. Its owner can grant it in the app's Choose Context step, under Agents.`, 'agent-grant');
  }
  const message = typeof input.message === 'string' && input.message.trim()
    ? input.message.trim()
    : typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim() : '';
  const r = await rpc('run_agent_system', {
    systemId,
    message: message || 'Do your standard job: assess the current state, then give your recommended actions with the reasons.',
    ...(Array.isArray(input.messages) ? { messages: input.messages } : {}),
  });
  if (!r.ok) {
    const status = STATUS_BY_CODE[r.code ?? ''] ?? 502;
    const tr = await trace({ principal, tool, input, output: { error: r.message }, decision: status === 403 ? 'deny' : 'allow' });
    return { status, body: { tool, principal, decision: status === 403 ? 'deny' : 'allow', policy: 'app-grant', layer: 'agent-run', reason: r.message, traceId: tr.id } };
  }
  const result = parsed(r.text);
  const tr = await trace({ principal, tool, input, output: result, decision: 'allow' });
  return { status: 200, body: { tool, principal, decision: 'allow', policy: 'app-grant', traceId: tr.id, result } };
}
