/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import { ROLES, type Role } from '@/lib/session';
import { config } from '@/lib/config';
import { PLATFORM_MCP_TOOLS, callPlatformMcp } from '@/lib/software/platform-mcp';
import { authorize, queryRun, trace } from '@/lib/governed';
import { servePredict } from '@/lib/science/serve';
import type { ChurnFeatures } from '@/lib/science';
import { retrieveKnowledge } from '@/lib/knowledge/retrieve';
import { listSystems } from '@/lib/agents/store';
import { ALL_WRITE_TOOLS } from '@/lib/mcp/write-tools';

/**
 * THE SOVEREIGN AGENTIC OS — remote MCP server (JSON-RPC 2.0 core).
 *
 * This is the ONE governed MCP surface a user imports into Claude / ChatGPT. It
 * is a pure, transport-free dispatcher (the HTTP/Streamable-HTTP shell lives in
 * `app/api/mcp/route.ts`) so it is trivially unit-testable.
 *
 * GOVERNANCE INVARIANT (inherited, not re-implemented): every tool delegates to
 * the EXACT SAME governed library function the UI + the bespoke `/api` routes
 * call, under the caller's delegated identity — so OPA policy, Langfuse audit and
 * role gates apply unchanged. There is NO privileged path here. The role→tool
 * visibility below is a conservative FLOOR: the underlying governed function is
 * always the real authority and is re-checked on every call (`tools/call` never
 * trusts the client, and re-checks the visibility floor too).
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_INFO = {
  name: 'sovereign-agentic-os',
  title: 'Sovereign Agentic OS',
  version: config.osVersion,
} as const;

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  /** Short schema-level note for the AI consumer. */
  description?: string;
  /** ≥1 worked example per write tool — an AI reads these to call correctly. */
  examples?: unknown[];
};

/**
 * The OS tabs that expose an MCP tool surface. Each tab gets a filtered view of
 * the ONE registry below (`/api/mcp/<tab>`) — a scoped lens, never a second
 * governance path. The overarching `/api/mcp` endpoint still serves them all.
 */
export const MCP_TABS = ['software', 'data', 'science', 'knowledge', 'agents', 'files', 'metrics', 'dashboards', 'bigbets'] as const;
export type McpTab = (typeof MCP_TABS)[number];
export function isMcpTab(x: string): x is McpTab {
  return (MCP_TABS as readonly string[]).includes(x);
}

/**
 * `meta` is NOT a real tab (no route, no header button) — it tags the cross-cutting
 * discovery tools (`whoami`, `list_capabilities`) so they surface in EVERY per-tab
 * view AND the overarching endpoint. Kept out of {@link MCP_TABS} on purpose.
 */
export type ToolTab = McpTab | 'meta';

export type McpTool = {
  name: string;
  description: string;
  /** Lowest role that may SEE + CALL this tool (the governed fn still re-gates). */
  minRole: Role;
  /** The OS tab this tool lives under (used to build the per-tab MCP view). */
  tab: ToolTab;
  inputSchema: JsonSchema;
  call: (user: CurrentUser, args: Record<string, unknown>) => Promise<unknown>;
};

function rank(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleCanUse(role: Role, minRole: Role): boolean {
  return rank(role) >= rank(minRole);
}

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// --- Platform tools (create→build→preview→deploy parity) -----------------------
// Elevated tools are role-gated in the governed layer (promote/decide_deploy →
// builder+, delete → owner-or-builder+); we mirror that as the visibility floor.
const ELEVATED = new Set(['promote', 'decide_deploy', 'delete']);

const APP_ID_ONLY: JsonSchema = {
  type: 'object',
  properties: { appId: { type: 'string', description: 'Target app id.' } },
  required: ['appId'],
};

const CONSUME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    appId: { type: 'string', description: 'App consuming the resource.' },
    ref: { type: 'string', description: 'Reference to the granted resource (never a raw credential).' },
    label: { type: 'string', description: 'Human label for the consumed resource.' },
    scope: { type: 'string', enum: ['read', 'write-bounded'], description: 'Consumption scope.' },
  },
  required: ['appId', 'ref'],
};

const PLATFORM_SCHEMAS: Record<string, JsonSchema> = {
  create_software: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'App name.' },
      description: { type: 'string' },
      template: { type: 'string', description: "Template key (e.g. 'nextjs-supabase')." },
      domain: { type: 'string', description: 'Domain to create in (must be one of yours).' },
    },
    required: ['name'],
  },
  commit: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      message: { type: 'string', description: 'Commit message.' },
      name: { type: 'string' },
      description: { type: 'string' },
      files: {
        type: 'array',
        description: 'Files to commit.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    required: ['appId'],
  },
  start_preview: APP_ID_ONLY,
  request_deploy: APP_ID_ONLY,
  decide_deploy: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: 'Deploy review card id.' },
      decision: { type: 'string', enum: ['approve', 'deny'] },
      note: { type: 'string' },
    },
    required: ['cardId', 'decision'],
  },
  use_connection: CONSUME_SCHEMA,
  use_data: CONSUME_SCHEMA,
  use_knowledge: CONSUME_SCHEMA,
  use_as_data: APP_ID_ONLY,
  promote: APP_ID_ONLY,
  archive: APP_ID_ONLY,
  delete: APP_ID_ONLY,
};

const platformTools: McpTool[] = PLATFORM_MCP_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  minRole: ELEVATED.has(t.name) ? 'builder' : 'creator',
  tab: 'software',
  inputSchema: PLATFORM_SCHEMAS[t.name] ?? APP_ID_ONLY,
  call: (user, args) => callPlatformMcp(user, t.name, args),
}));

// --- Cross-OS high-value tools -------------------------------------------------
const crossTools: McpTool[] = [
  {
    name: 'query_data',
    description:
      'Run a read-only SQL query over the governed Iceberg marts (Trino). OPA-authorized on your domain and Langfuse-audited, exactly like the UI data tool.',
    minRole: 'creator',
    tab: 'data',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A read-only SQL statement.' } },
      required: ['sql'],
    },
    call: async (user, args) => {
      const sql = str(args.sql).trim();
      if (!sql) fail('query_data needs a `sql` string', 400);
      const principal = user.domains[0] ?? user.id;
      const authz = await authorize(principal, 'query');
      if (!authz.allowed) fail(`OPA denied ${principal} → query (${authz.policy})`, 403);
      const result = await queryRun(sql, principal);
      const traced = await trace({ principal, tool: 'query', input: sql, output: result.rows });
      return { principal, authorized: true, policy: authz.policy, traced, ...result };
    },
  },
  {
    name: 'science_predict',
    description:
      'Score the deployed churn model through the governed predict door (tier scope + OPA `predict` grant, then a Langfuse trace).',
    minRole: 'creator',
    tab: 'science',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id to score.' },
        features: { type: 'object', description: 'Optional feature overrides.' },
      },
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true to enable predict', 404);
      const result = await servePredict({
        account: str(args.account) || undefined,
        features: (args.features as Partial<ChurnFeatures>) || undefined,
        principal: 'sales-assistant',
        domains: user.domains,
        isAgent: true,
        requestedBy: user.id,
      });
      return result.body;
    },
  },
];

// --- Knowledge tab (governed retrieval) ----------------------------------------
const knowledgeTools: McpTool[] = [
  {
    name: 'search_knowledge',
    description:
      'Governed hybrid knowledge retrieval (dense + lexical, reranked) with provenance for citations. Runs the same OPA `retrieve` gate + document-level grant filter as the Knowledge tab — you only ever see units you are entitled to.',
    minRole: 'creator',
    tab: 'knowledge',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to retrieve.' },
        k: { type: 'number', description: 'Max hits (default 6, capped at 20).' },
      },
      required: ['query'],
    },
    call: async (user, args) => {
      const query = str(args.query).trim();
      if (!query) fail('search_knowledge needs a `query` string', 400);
      const k = typeof args.k === 'number' && args.k > 0 ? Math.min(Math.floor(args.k), 20) : undefined;
      return retrieveKnowledge(
        query,
        { id: user.id, domains: user.domains, role: user.role },
        k ? { k } : {},
      );
    },
  },
];

// --- Agents tab (read-only system inventory) -----------------------------------
const agentTools: McpTool[] = [
  {
    name: 'list_agent_systems',
    description:
      'List the agent systems you can see (yours, domain-shared, marketplace). Read-only and scoped to your identity — the same visibility rule as the Agents tab.',
    minRole: 'creator',
    tab: 'agents',
    inputSchema: { type: 'object', properties: {} },
    call: async (user) => listSystems({ id: user.id, domains: user.domains, role: user.role }),
  },
];

// --- Discovery (meta) tools — make the OS legible to an AI consumer ------------
/** A plain-language read of what a role can / cannot do (the creator lockdown). */
function capabilitySummary(role: Role): { can: string[]; cannot: string[] } {
  const builder = roleCanUse(role, 'builder');
  const admin = roleCanUse(role, 'admin');
  return {
    can: [
      'create datasets, files, knowledge workflows, metrics, dashboards, big bets and agent systems in your own domain(s)',
      'build, document and query your own work',
      ...(builder ? ['promote/publish your work to a SHARED domain asset (dataset/file/workflow/agent)'] : []),
      ...(admin ? ['certify to the cross-domain marketplace', 'own a cross-domain big bet'] : []),
    ],
    cannot: [
      ...(!builder ? ['promote/publish to a shared domain asset — that is Builder+ (ask a Builder, or keep it Personal)'] : []),
      ...(!admin ? ['certify to the marketplace — that is Admin-only'] : []),
    ],
  };
}

const discoveryTools: McpTool[] = [
  {
    name: 'whoami',
    tab: 'meta',
    minRole: 'creator',
    description:
      'Return the caller’s delegated identity (id, name, role, domains) and a plain-language read of what this role can and cannot do. Every write tool runs AS this user — start here.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      domains: user.domains,
      ...capabilitySummary(user.role),
    }),
  },
  {
    name: 'list_capabilities',
    tab: 'meta',
    minRole: 'creator',
    description:
      'List every OS tool with its tab + role gate, split into what THIS caller can call now vs. what is gated to a higher role (and why). The map an AI reads before building a case study across tabs.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => {
      const rows = ALL_MCP_TOOLS.map((t) => ({
        name: t.name,
        tab: t.tab,
        minRole: t.minRole,
        description: t.description,
      }));
      const available = rows.filter((r) => roleCanUse(user.role, r.minRole));
      const gated = rows
        .filter((r) => !roleCanUse(user.role, r.minRole))
        .map((r) => ({ ...r, reason: `requires ${r.minRole}; you are ${user.role}` }));
      return { role: user.role, availableCount: available.length, available, gated };
    },
  },
];

export const ALL_MCP_TOOLS: McpTool[] = [
  ...platformTools,
  ...crossTools,
  ...knowledgeTools,
  ...agentTools,
  ...ALL_WRITE_TOOLS,
  ...discoveryTools,
];

/**
 * The subset of the registry that lives under one tab (the per-tab MCP view). The
 * cross-cutting `meta` discovery tools are ALWAYS included so `whoami` /
 * `list_capabilities` work on every per-tab endpoint too.
 */
export function toolsForTab(tab: McpTab): McpTool[] {
  return ALL_MCP_TOOLS.filter((t) => t.tab === tab || t.tab === 'meta');
}

/** The role-scoped, wire-shaped tool list for `tools/list` (no internals leak). */
export function listToolsForRole(
  role: Role,
  tools: McpTool[] = ALL_MCP_TOOLS,
): { name: string; description: string; inputSchema: JsonSchema }[] {
  return tools.filter((t) => roleCanUse(role, t.minRole)).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

// --- JSON-RPC 2.0 dispatch -----------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Optional per-endpoint scoping. The overarching `/api/mcp` passes nothing (→ the
 * full registry + generic serverInfo); a per-tab `/api/mcp/<tab>` passes that
 * tab's filtered tool subset, a per-tab serverInfo, and its CONTEXT.md as MCP
 * `instructions`. It is a lens, NOT a second governance path — every tools/call
 * still routes through the same governed function and is re-gated by role.
 */
export type HandleRpcOptions = {
  tools?: McpTool[];
  serverInfo?: { name: string; title: string; version: string };
  instructions?: string;
};

/**
 * Handle a single JSON-RPC request under the caller's delegated identity.
 * Returns the response object, or `null` for a notification (no reply expected).
 */
export async function handleRpc(
  user: CurrentUser,
  req: JsonRpcRequest,
  opts: HandleRpcOptions = {},
): Promise<JsonRpcResponse | null> {
  const id = req?.id ?? null;
  const method = req?.method;
  const tools = opts.tools ?? ALL_MCP_TOOLS;

  // Notifications (e.g. notifications/initialized) get no response body.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: opts.serverInfo ?? MCP_SERVER_INFO,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: listToolsForRole(user.role, tools) });

    case 'tools/call': {
      const params = req.params ?? {};
      const name = str(params.name);
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const tool = tools.find((t) => t.name === name);
      // An unknown / out-of-scope tool stays a JSON-RPC error (don't even hint at
      // tools this endpoint doesn't serve).
      if (!tool) return rpcError(id, -32602, `Tool not available: ${name || '(none)'}`);
      // Re-check the role floor on every call — never trust the client. A denial is a
      // TYPED forbidden content block (the client named this tool, so this is a hint,
      // not a leak): the AI learns exactly what role it needs.
      if (!roleCanUse(user.role, tool.minRole)) {
        return toolError(id, {
          code: 'forbidden',
          reason: `${tool.name} requires ${tool.minRole}; you are ${user.role}`,
          hint: `Ask a ${tool.minRole} to run it, or keep your work Personal.`,
        });
      }
      try {
        const result = await tool.call(user, args);
        return ok(id, { content: [{ type: 'text', text: safeText(result) }] });
      } catch (e) {
        // Governance denials + execution failures surface as a TYPED MCP tool error
        // (isError + structuredContent) — model-readable, actionable, NEVER a crash.
        return toolError(id, structuredError(e));
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method ?? '(none)'}`);
  }
}

/** A structured, model-readable tool error: `{ error: { code, reason, hint } }`. */
export type ToolError = { code: string; reason: string; hint: string };

function toolError(id: string | number | null | undefined, error: ToolError): JsonRpcResponse {
  return ok(id, {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  });
}

/** Map a thrown error (its HTTP-ish `status`) to a typed code + an actionable hint. */
export function structuredError(e: unknown): ToolError {
  const status = (e as { status?: number }).status;
  const reason = (e as Error).message || 'Tool execution failed';
  const code =
    status === 403 ? 'forbidden'
      : status === 404 ? 'not_found'
        : status === 409 ? 'conflict'
          : status === 400 ? 'bad_request'
            : 'error';
  const hint =
    code === 'forbidden'
      ? 'This needs a higher role or a domain you belong to — ask a Builder/Admin, or keep it Personal.'
      : code === 'not_found'
        ? 'Check the id — call list_capabilities or the tab’s list tool first.'
        : code === 'conflict'
          ? 'Already in that state — this call is idempotent, so no further action is needed.'
          : code === 'bad_request'
            ? 'Check your arguments against the tool’s inputSchema (each carries an example).'
            : 'Unexpected failure — retry, or inspect `reason`.';
  return { code, reason, hint };
}

function safeText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
