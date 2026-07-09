/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Visibility } from '@/lib/artifact-model';

/**
 * Auto-generated MCP / app-connection registry (Software golden path §4).
 *
 * When an app is created, the platform auto-generates an MCP server exposing the
 * app's capabilities as tools, registers it as a Connection (visible in the
 * Connections surface) and grants the app's principal those tools so the
 * creator's agents can call them. Locally there is no live OPA/LiteLLM, so this
 * in-process registry is the offline source of truth — exactly mirroring the
 * `lib/artifacts.ts` in-memory + write-through pattern. `lib/agent-governed.ts`
 * consults `grantsFor()` so the SAME authorize→trace spine governs an app's MCP
 * tool as governs any other tool, with no chart redeploy needed for a new app.
 *
 * Kept dependency-free (no apps.ts, no agent-governed.ts) so it can be imported
 * by both without an import cycle.
 */

export type AppTool = {
  name: string;
  description: string;
  /** write tools mutate app state; read tools are side-effect-free. */
  write: boolean;
};

export type AppConnection = {
  id: string;
  appId: string;
  /** Display name in the Connections surface, e.g. "Renewals Tracker MCP". */
  name: string;
  /** OPA/LiteLLM principal the app's MCP runs as, e.g. "app-renewals-tracker". */
  principal: string;
  tools: AppTool[];
  owner: string;
  domain: string;
  visibility: Visibility;
  createdAt: string;
};

/**
 * State pinned to `globalThis` — the Next App Router bundles each route handler
 * separately, so a module-scoped Map would give every route its own empty copy: a
 * connection registered by the app-create route would be invisible to the
 * Connections / agent-governed routes. Pinning makes the registry a true singleton
 * and survives dev HMR. (Same reason marketplace/approvals/agents stores pin.)
 */
type RegistryState = { grants: Map<string, Set<string>>; conns: Map<string, AppConnection> };
const STATE_KEY = Symbol.for('soa.app-registry.state');
function state(): RegistryState {
  const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { grants: new Map(), conns: new Map() };
  return g[STATE_KEY]!;
}
// principal -> granted tool names. The dynamic equivalent of opa.grants.
const GRANTS = state().grants;
// connection id -> connection.
const CONNS = state().conns;

/** Register (or replace) an app's auto-generated MCP connection + its grant. */
export function registerConnection(conn: AppConnection): AppConnection {
  CONNS.set(conn.id, conn);
  GRANTS.set(conn.principal, new Set(conn.tools.map((t) => t.name)));
  return conn;
}

/**
 * SELF-HEALING GRANT REHYDRATION (durability across pod restarts).
 *
 * The {@link GRANTS} map is in-memory: it survives dev HMR (globalThis pin) but is
 * EMPTY after a pod restart, so every os-ui redeploy wipes the dynamic grants a
 * Build wrote for an agent system's principal (`os-<id>`). Without this, the first
 * governed tool call after a restart falls through to the offline OPA mirror, which
 * only knows the STATIC chart grants — so a dynamically-built agent's `query_data`
 * denies until it is rebuilt (the observed flip-flop).
 *
 * A DurableGrantResolver reads the principal's grant set back from the persisted
 * agent-system record (the SAME OpenSearch os-mirror `list_agent_systems` reads),
 * so the first tool call after a restart RE-REGISTERS the grants from the durable
 * record — no rebuild needed. Injected (not imported) so this module stays
 * dependency-free and free of an import cycle with the store.
 *
 * FAIL-CLOSED: a resolver that returns `null`/`[]` grants NOTHING — the authorize
 * path then falls to the existing OPA/deny. Rehydration can only re-register EXACTLY
 * what the persisted record already lists; it never broadens a grant.
 */
export type DurableGrantResolver = (principal: string) => Promise<string[] | null>;

const RESOLVER_KEY = Symbol.for('soa.app-registry.grantResolver');
export function registerDurableGrantResolver(resolver: DurableGrantResolver): void {
  (globalThis as unknown as Record<symbol, DurableGrantResolver | undefined>)[RESOLVER_KEY] = resolver;
}
function durableGrantResolver(): DurableGrantResolver | undefined {
  return (globalThis as unknown as Record<symbol, DurableGrantResolver | undefined>)[RESOLVER_KEY];
}

/** Tools granted to a principal (offline OPA mirror for app MCPs). */
export function grantsFor(principal: string): string[] {
  return [...(GRANTS.get(principal) ?? new Set<string>())];
}

/**
 * Tools granted to a principal, LAZILY REHYDRATED from the durable store when the
 * in-memory grant set is empty/missing (e.g. right after a pod restart). On a hit
 * the resolved grants are cached back into {@link GRANTS} so subsequent calls are
 * the fast sync path again. Fail-closed: an absent resolver or a record with no
 * grants leaves the principal ungranted (`[]`).
 */
export async function grantsForDurable(principal: string): Promise<string[]> {
  const existing = grantsFor(principal);
  if (existing.length > 0) return existing;
  const resolver = durableGrantResolver();
  if (!resolver) return existing;
  let tools: string[] | null = null;
  try {
    tools = await resolver(principal);
  } catch {
    // A failed lookup must NEVER grant — fall through to the empty (deny) set.
    return existing;
  }
  if (!tools || tools.length === 0) return existing;
  GRANTS.set(principal, new Set(tools));
  return [...tools];
}

export function getConnection(id: string): AppConnection | null {
  return CONNS.get(id) ?? null;
}

export function getConnectionByApp(appId: string): AppConnection | null {
  for (const c of CONNS.values()) if (c.appId === appId) return c;
  return null;
}

/** All registered app connections (most recent first). */
export function listConnections(): AppConnection[] {
  return [...CONNS.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Update a connection's visibility when its app is promoted. */
export function setConnectionVisibility(appId: string, visibility: Visibility): void {
  const c = getConnectionByApp(appId);
  if (c) c.visibility = visibility;
}

/** Remove an app's connection + grant (de-provisioning). */
export function removeConnection(appId: string): void {
  const c = getConnectionByApp(appId);
  if (!c) return;
  GRANTS.delete(c.principal);
  CONNS.delete(c.id);
}
