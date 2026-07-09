/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { ROLES, type Role } from '@/lib/core/session';
import type { Visibility } from '@/lib/core/artifact-model';

/**
 * MCPs & APIs registry aggregator (Platform → MCPs & APIs).
 *
 * A PURE, dependency-light assembler (no `server-only`, no network, no OPA) so it
 * is trivially unit-testable AND importable by the client page for its types. The
 * route (`/api/platform-admin/mcp-apis`) does the impure gathering — reads the OS
 * tool registry, the LiteLLM gateway, the app + connection registries — then hands
 * the plain data to `buildMcpRegistry`, which shapes the FOUR sections and applies
 * role scoping + tier filtering. The security boundary is the caller: the route is
 * admin-gated (`adminCtx`) and the owned lists are already visibility-scoped to the
 * caller, so this file only has to filter, never to authorize.
 *
 * The four sections, in order (1 is primary):
 *   1. official   — the OS's own MCP surface (overarching + per-tab) + platform APIs.
 *   2. stack      — MCP servers of the bundled stack tools (LiteLLM gateway registry).
 *   3. shared     — app/connection MCPs shared in a domain or the Marketplace.
 *   4. personal   — the caller's own, not-yet-shared app/connection MCPs.
 */

export type McpTier = 'official' | 'stack' | 'shared' | 'personal';

export type RegistryTool = { name: string; description?: string };

export type RegistryEntry = {
  id: string;
  /** An MCP server vs a plain HTTP API surface. */
  kind: 'mcp' | 'api';
  name: string;
  description: string;
  /** URL or internal path / governed reference (never a secret). */
  endpoint: string;
  /** e.g. 'Streamable-HTTP', 'HTTP' — omitted for plain APIs. */
  transport?: string;
  /** The tools this server exposes (names + optional one-liners). */
  tools: RegistryTool[];
  /** Short scope/tier badge text (role floor, visibility, or status). */
  scope: string;
  /** Whether the OS remote-MCP import affordance (per-user bearer) applies. */
  importable: boolean;
  /** For an importable OS MCP: which tab view (undefined = overarching). */
  mcpTab?: string;
  owner?: string;
  domain?: string;
  visibility?: Visibility;
  /** Whether the server is live/reachable (stack tools) vs coming online. */
  live?: boolean;
};

export type RegistrySection = {
  tier: McpTier;
  title: string;
  subtitle: string;
  /** The primary (main) section renders with emphasis. */
  primary?: boolean;
  entries: RegistryEntry[];
};

export type McpRegistry = { sections: RegistrySection[] };

// --- Inputs (the plain data the route gathers) ---------------------------------

/** One tool from the OS's own registry (`ALL_MCP_TOOLS`), flattened. */
export type OfficialToolInput = {
  name: string;
  description: string;
  /** Lowest role that may see + call it (the visibility floor). */
  minRole: Role;
  /** The OS tab it lives under. */
  tab: string;
};

/** One bundled-stack MCP server (mirrors `litellm.proxy_config.mcp_servers`). */
export type StackServerInput = {
  id: string;
  name: string;
  description: string;
  url: string;
  transport: string;
  /** Statically-declared tools; replaced by live gateway tools when live. */
  tools: RegistryTool[];
  /** true when the server is wired + reachable through the gateway today. */
  live: boolean;
  /** Optional status badge, e.g. 'coming online'. */
  status?: string;
};

/** An app- or connection-generated MCP the caller can already see. */
export type OwnedMcpInput = {
  id: string;
  source: 'app' | 'connection';
  name: string;
  description: string;
  /** URL or governed `mcp://<principal>` reference. */
  endpoint: string;
  principal: string;
  tools: RegistryTool[];
  visibility: Visibility;
  owner: string;
  domain: string;
};

export type BuildInput = {
  role: Role;
  userId: string;
  officialTools: OfficialToolInput[];
  tabs: readonly string[];
  /** Curated platform HTTP APIs (already shaped as API entries). */
  officialApis?: RegistryEntry[];
  stackServers: StackServerInput[];
  /** Live tool list from the gateway; attached to the live stack entry. */
  liveGatewayTools?: RegistryTool[];
  /** App + connection MCPs, pre-scoped to the caller by the route. */
  ownedMcps: OwnedMcpInput[];
};

// --- Role helper ---------------------------------------------------------------

function rank(role: Role): number {
  return ROLES.indexOf(role);
}

/** Role can see a tool iff its rank meets the tool's floor (mirrors the OS gate). */
export function roleCanSee(role: Role, minRole: Role): boolean {
  return rank(role) >= rank(minRole);
}

// --- Section builders (pure) ---------------------------------------------------

const TAB_TITLES: Record<string, string> = {
  software: 'Software',
  data: 'Data',
  science: 'Science',
  knowledge: 'Knowledge',
  agents: 'Agents',
};

/**
 * Section 1 (primary) — the OS's own MCP surface. The overarching endpoint plus
 * one entry per OS tab, each showing only the tools the caller's role may see, and
 * the curated platform APIs. Every OS MCP entry is importable (per-user bearer).
 */
export function buildOfficialSection(
  role: Role,
  officialTools: OfficialToolInput[],
  tabs: readonly string[],
  officialApis: RegistryEntry[] = [],
): RegistrySection {
  const visible = officialTools.filter((t) => roleCanSee(role, t.minRole));
  const asTool = (t: OfficialToolInput): RegistryTool => ({ name: t.name, description: t.description });

  const overarching: RegistryEntry = {
    id: 'os-mcp',
    kind: 'mcp',
    name: 'Sovereign Agentic OS — MCP',
    description:
      'The one governed MCP surface for the whole OS. Per-user token, role-scoped tools, every call under your identity through the same OPA + audit path as the UI.',
    endpoint: '/api/mcp',
    transport: 'Streamable-HTTP',
    tools: visible.map(asTool),
    scope: `role ${role}`,
    importable: true,
  };

  const perTab: RegistryEntry[] = tabs.map((tab) => {
    const tabTools = visible.filter((t) => t.tab === tab);
    return {
      id: `os-mcp-${tab}`,
      kind: 'mcp',
      name: `${TAB_TITLES[tab] ?? tab} tab — MCP`,
      description: `A scoped view of the OS MCP: only the ${TAB_TITLES[tab] ?? tab} tab's governed tools, same token, same governance.`,
      endpoint: `/api/mcp/${tab}`,
      transport: 'Streamable-HTTP',
      tools: tabTools.map(asTool),
      scope: `tab · role ${role}`,
      importable: true,
      mcpTab: tab,
    };
  });

  return {
    tier: 'official',
    title: 'Official — Sovereign Agentic OS',
    subtitle: "The product's own MCP servers and platform APIs — the governed surface you import once and drive the whole OS from.",
    primary: true,
    entries: [overarching, ...perTab, ...officialApis],
  };
}

/**
 * Section 2 — the bundled stack tools' MCP servers (the LiteLLM gateway registry).
 * Agents reach these through the one governed gateway, so they are not per-user
 * importable. Live tools from the gateway enrich the live entry when available.
 */
export function buildStackSection(
  stackServers: StackServerInput[],
  liveGatewayTools: RegistryTool[] = [],
): RegistrySection {
  const entries: RegistryEntry[] = stackServers.map((s) => ({
    id: `stack-${s.id}`,
    kind: 'mcp',
    name: s.name,
    description: s.description,
    endpoint: s.url,
    transport: s.transport,
    tools: s.live && liveGatewayTools.length ? liveGatewayTools : s.tools,
    scope: s.status ?? (s.live ? 'live · gateway' : 'stack'),
    importable: false,
    live: s.live,
  }));
  return {
    tier: 'stack',
    title: 'Stack tools',
    subtitle: 'MCP servers of the tools bundled in the stack, fronted by the governed LiteLLM gateway.',
    entries,
  };
}

function ownedToEntry(m: OwnedMcpInput): RegistryEntry {
  return {
    id: `owned-${m.id}`,
    kind: 'mcp',
    name: m.name,
    description: m.description,
    endpoint: m.endpoint,
    tools: m.tools,
    scope: m.source === 'app' ? 'app auto-MCP' : 'connection',
    importable: false,
    owner: m.owner,
    domain: m.domain,
    visibility: m.visibility,
  };
}

/**
 * Section 3 — app/connection MCPs shared in a domain (Shared) or published to the
 * Marketplace (Certified). Sourced from the caller-scoped owned list, tier-filtered.
 */
export function buildSharedSection(ownedMcps: OwnedMcpInput[]): RegistrySection {
  const entries = ownedMcps
    .filter((m) => m.visibility === 'Shared' || m.visibility === 'Certified')
    .map(ownedToEntry);
  return {
    tier: 'shared',
    title: 'Shared',
    subtitle: 'MCPs auto-generated by your apps and connections, shared in a domain or published to the Marketplace.',
    entries,
  };
}

/**
 * Section 4 — the caller's own app/connection MCPs still at the Personal tier
 * (owned by the caller, not shared yet).
 */
export function buildPersonalSection(ownedMcps: OwnedMcpInput[], userId: string): RegistrySection {
  const entries = ownedMcps
    .filter((m) => m.visibility === 'Personal' && m.owner === userId)
    .map(ownedToEntry);
  return {
    tier: 'personal',
    title: 'Personal',
    subtitle: 'Your own app and connection MCPs, private to you until you promote them to Shared.',
    entries,
  };
}

/** Assemble the full four-section registry from the gathered inputs. */
export function buildMcpRegistry(input: BuildInput): McpRegistry {
  return {
    sections: [
      buildOfficialSection(input.role, input.officialTools, input.tabs, input.officialApis),
      buildStackSection(input.stackServers, input.liveGatewayTools),
      buildSharedSection(input.ownedMcps),
      buildPersonalSection(input.ownedMcps, input.userId),
    ],
  };
}

// --- Static registries (mirror the chart + platform surface) -------------------

/**
 * The bundled-stack MCP servers, mirroring `litellm.proxy_config.mcp_servers` in
 * `charts/sovereign-agentic-os/values.yaml`. `sovereign_query` is wired + live
 * today; the rest come online as the chart enables them (honestly flagged).
 */
export const STACK_MCP_SERVERS: StackServerInput[] = [
  {
    id: 'sovereign_query',
    name: 'Governed lakehouse query (Trino)',
    description:
      'Governed SQL over the lakehouse marts via central Trino — row/column governed. The stack MCP agents call through the gateway.',
    url: 'http://query-tool:8000/mcp',
    transport: 'http',
    tools: [
      { name: 'sovereign_query', description: 'Run a governed, read-only SQL query over the Iceberg marts.' },
    ],
    live: true,
  },
  {
    id: 'superset',
    name: 'Superset',
    description: 'Dashboards & charts over the governed marts. MCP surface comes online as Superset is enabled.',
    url: 'http://superset:8088/mcp',
    transport: 'http',
    tools: [],
    live: false,
    status: 'coming online',
  },
  {
    id: 'openmetadata',
    name: 'OpenMetadata',
    description: 'Catalog, lineage & glossary. MCP surface comes online as OpenMetadata is enabled.',
    url: 'http://openmetadata:8585/mcp',
    transport: 'http',
    tools: [],
    live: false,
    status: 'coming online',
  },
  {
    id: 'dbt',
    name: 'dbt',
    description: 'Transformations & tests over the marts. MCP surface comes online as dbt is enabled.',
    url: 'http://dbt:8080/mcp',
    transport: 'http',
    tools: [],
    live: false,
    status: 'coming online',
  },
];

/** Curated official platform HTTP APIs surfaced alongside the OS MCP servers. */
export const OFFICIAL_PLATFORM_APIS: RegistryEntry[] = [
  {
    id: 'api-gateway',
    kind: 'api',
    name: 'Gateway API',
    description: 'The models + registered MCP tools the agents call — LiteLLM, per-key access + cost caps, Langfuse-logged.',
    endpoint: '/api/gateway',
    tools: [],
    scope: 'platform API',
    importable: false,
  },
  {
    id: 'api-mcp-token',
    kind: 'api',
    name: 'MCP token',
    description: 'Mints your personal, role-scoped bearer token for the OS remote MCP endpoint (cookie-authenticated).',
    endpoint: '/api/mcp/token',
    tools: [],
    scope: 'platform API',
    importable: false,
  },
  {
    id: 'api-connections',
    kind: 'api',
    name: 'Connections API',
    description: 'The governed connections visible to you (Personal + domain Shared + Marketplace) and their capability profiles.',
    endpoint: '/api/connections',
    tools: [],
    scope: 'platform API',
    importable: false,
  },
];
