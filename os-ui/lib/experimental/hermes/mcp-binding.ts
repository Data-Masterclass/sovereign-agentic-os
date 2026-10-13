/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Platform-MCP-over-HTTP binding (hermes-agent-integration-plan.md §3).
 *
 * Register our ONE governed Platform MCP as an HTTP MCP server inside a Hermes
 * profile, authenticated with the test user's Ory OAuth (Bearer / OAuth 2.1) or
 * mTLS for service agents. `tools.include` exposes ONLY the preset's tool set.
 * Because Hermes calls the SAME `/api/mcp` surface every other client uses, OPA
 * still gates each call (`allow / deny / requires_approval`) and RLS still holds
 * (the call carries the profile's delegated identity) — there is NO side door.
 *
 * PURE module: it builds the binding + validates it. The actual JSON-RPC dispatch
 * (auth → OPA → governed fn → Langfuse) is `lib/mcp/server.ts` unchanged.
 */

import type { HermesMcpServer, McpAuth } from './provisioner.ts';

export type PlatformMcpBinding = {
  server: HermesMcpServer;
  /** The delegated principal this binding acts as (→ RLS + OPA scope). */
  principal: string;
  /** The domain this profile is scoped to (RLS row scope). */
  domain: string;
};

/**
 * Build the binding. `mcpUrl` MUST be the platform's `/api/mcp` (or a per-tab
 * lens of it), never a per-provider endpoint. The OAuth token carries the user's
 * Ory identity, so the binding runs AS the user (agents-run-as-user, decision R2).
 */
export function bindPlatformMcp(input: {
  identity: { user: string; domain: string };
  mcpUrl: string;
  auth: McpAuth;
  toolsInclude: string[];
  serverName?: string;
}): PlatformMcpBinding {
  return {
    server: {
      name: input.serverName ?? 'platform-mcp',
      transport: 'http',
      url: input.mcpUrl,
      auth: input.auth,
      toolsInclude: [...input.toolsInclude],
    },
    principal: input.identity.user,
    domain: input.identity.domain,
  };
}

export type BindingViolation = { property: string; detail: string };

/**
 * Validate a binding preserves the governed plane: HTTP transport, an auth
 * (OAuth bearer or mTLS), a non-empty tools.include whitelist, and a platform MCP
 * URL (not a raw provider). Returns [] when clean.
 */
export function validateBinding(b: PlatformMcpBinding): BindingViolation[] {
  const v: BindingViolation[] = [];
  if (b.server.transport !== 'http') v.push({ property: 'transport', detail: 'binding must be HTTP MCP' });
  if (!b.server.auth) v.push({ property: 'auth', detail: 'binding is unauthenticated (no Ory OAuth / mTLS)' });
  else if (b.server.auth.kind === 'oauth' && !b.server.auth.tokenRef) {
    v.push({ property: 'auth', detail: 'OAuth binding has no token ref' });
  } else if (b.server.auth.kind === 'mtls' && (!b.server.auth.certRef || !b.server.auth.keyRef)) {
    v.push({ property: 'auth', detail: 'mTLS binding is missing cert/key refs' });
  }
  if (b.server.toolsInclude.length === 0) {
    v.push({ property: 'tools', detail: 'tools.include is empty — the profile would see no governed tools' });
  }
  if (!/\/api\/mcp(\b|\/|$)/.test(b.server.url)) {
    v.push({ property: 'url', detail: `MCP url '${b.server.url}' is not the governed /api/mcp surface` });
  }
  return v;
}

/**
 * The subset of a tool list a bound profile may actually SEE — the intersection
 * of what the server offers and the profile's `tools.include`. Mirrors the
 * server-side filter so a preset can be verified without a live gateway: a tool
 * the profile isn't included for is simply not visible (and, if called anyway,
 * OPA denies it and it is queued to Governance).
 */
export function visibleTools(offered: string[], toolsInclude: string[]): string[] {
  const allow = new Set(toolsInclude);
  return offered.filter((t) => allow.has(t));
}
