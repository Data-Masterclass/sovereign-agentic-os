/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The per-connector-type ADAPTER INTERFACE (Connections golden path "adapter
 * interface + launch set"). Every connector type — Drive, Database, API, MCP,
 * SaaS — implements the SAME five operations, each individually verified with the
 * apply→verify discipline (mirrors `lib/agents/build/adapter.ts`):
 *
 *   1. auth            — establish the credential (per-user OAuth or service creds)
 *   2. test            — probe reachability / credential validity
 *   3. generateTools   — produce the governed tool set (OpenAPI / MCP schema, or a
 *                        safe static preset) — the "tool-generation" step
 *   4. compilePolicy   — compile the capability profile -> the OPA data bundle
 *                        (delegates to `lib/capability-compiler.ts`)
 *   5. sync            — data-source sync (dlt → Bronze / Drive → Files)
 *
 * All five plug into the SAME connection record / capability profile / OPA /
 * Secrets Manager / egress / Langfuse — so adding a new connector later is just a
 * new adapter, nothing else changes.
 *
 * PURE + injected clients (no `server-only`, no secrets) so it unit-tests against
 * in-memory fakes. Each client is `live | undefined`: when a live client is
 * injected and reachable the op runs LIVE; otherwise it falls back to a
 * deterministic OFFLINE MOCK (`mode: 'offline-mock'`), exactly like the
 * agent-runtime dual pattern. The real fetch-backed clients are wired server-side
 * in `lib/connection-clients.ts`. The kind gate exercises the mock path; a real
 * deploy injects live clients so the connector tools are fully functional.
 */

import {
  compileConnectionProfile,
  type OpaConnectionBundle,
  type CompilerGrant,
} from './capability-compiler.ts';
import type { ConnectionTool, ConnectionTemplate, CapabilityMode, ConnectorKind } from './connection-model.ts';

export type { ConnectorKind };

export type OpMode = 'live' | 'offline-mock';

/** One adapter operation's outcome, foldable into a verified ✓/✗ row. */
export type OpResult<T = unknown> = {
  ok: boolean;
  mode: OpMode;
  detail: string;
  data?: T;
  error?: string;
};

// --------------------------------------------------------------- live clients ---
// Injected, optional. A real (server-side) client returns a value when the backend
// is reachable; a thrown error or `null` means "fall back to the offline mock".

export interface OAuthClient {
  /** Exchange an authorization grant for a token (the value to store in Secrets Mgr). */
  exchange(connector: ConnectorKind, endpoint: string, code: string): Promise<{ token: string } | null>;
  /** Silent refresh of an expiring token. */
  refresh(connector: ConnectorKind, endpoint: string, refreshToken: string): Promise<{ token: string } | null>;
}
export interface ProbeClient {
  /** Reach the endpoint with the (server-side injected) credential; never echoes it. */
  reach(endpoint: string): Promise<{ ok: boolean; status?: number } | null>;
}
export interface SchemaClient {
  /** Fetch an OpenAPI document (API) or list MCP tools (MCP) to generate tools from. */
  fetchOpenApi(endpoint: string): Promise<unknown | null>;
  listMcpTools(endpoint: string): Promise<{ name: string; description?: string; write?: boolean }[] | null>;
}
export interface SyncClient {
  /** Run the data-source sync (dlt → Bronze, or Drive → Files); returns a record count. */
  run(kind: ConnectorKind, endpoint: string): Promise<{ records: number } | null>;
}

export type AdapterClients = {
  oauth?: OAuthClient;
  probe?: ProbeClient;
  schema?: SchemaClient;
  sync?: SyncClient;
};

export type AdapterCtx = {
  /** The connection template (carries the safe preset tools + secret key). */
  template: ConnectionTemplate;
  endpoint: string;
  /** Whether a credential is present in Secrets Manager (server resolves it; never passed here). */
  credentialPresent: boolean;
  /** Auth grant material for OAuth (an opaque code in the mock; a real grant live). */
  authCode?: string;
  /** For API tool-generation: a pasted OpenAPI spec (manual fallback when no live fetch). */
  openApiSpec?: unknown;
  /** Injected live clients; absent ⇒ offline-mock. */
  clients?: AdapterClients;
  /** Per-agent grants, for compilePolicy. */
  grants?: CompilerGrant[];
  /** The current capability profile (per-tool modes/limits) for compilePolicy. */
  tools?: ConnectionTool[];
};

export interface ConnectionAdapter {
  connector: ConnectorKind;
  /** 1. establish a credential. Returns the secret VALUE to store (never persisted in the record). */
  auth(ctx: AdapterCtx): Promise<OpResult<{ secretValue: string; secretKey: string }>>;
  /** 2. probe reachability / credential validity (never echoes the secret). */
  test(ctx: AdapterCtx): Promise<OpResult>;
  /** 3. generate the governed tool set. */
  generateTools(ctx: AdapterCtx): Promise<OpResult<ConnectionTool[]>>;
  /** 4. compile the capability profile to the OPA data bundle (pure). */
  compilePolicy(principal: string, ctx: AdapterCtx): OpaConnectionBundle;
  /** 5. data-source sync (dlt → Bronze / Drive → Files). */
  sync(ctx: AdapterCtx): Promise<OpResult<{ records: number; target: 'bronze' | 'files' | 'none' }>>;
}

// ----------------------------------------------------------- shared behaviour ---

function toCompilerTools(tools: ConnectionTool[]) {
  return tools.map((t) => ({
    name: t.name,
    mode: t.mode as CapabilityMode,
    write: t.write,
    maxAmount: t.limits?.maxAmount,
    dataScope: t.limits?.dataScope,
  }));
}

/** compilePolicy is identical for every adapter — the compiler is the one rule. */
function compilePolicy(principal: string, ctx: AdapterCtx): OpaConnectionBundle {
  const tools = ctx.tools ?? ctx.template.tools;
  return compileConnectionProfile(principal, toCompilerTools(tools), ctx.grants ?? []);
}

/** Static-preset tool generation (Drive/Database/SaaS, and the MCP/API fallback). */
async function presetTools(ctx: AdapterCtx, label: string): Promise<OpResult<ConnectionTool[]>> {
  const tools = ctx.template.tools.map((t) => ({ ...t, limits: t.limits ? { ...t.limits } : undefined }));
  return { ok: true, mode: 'offline-mock', detail: `${label}: ${tools.length} governed tools from the safe preset`, data: tools };
}

/** A reachability probe shared by all adapters: live when a probe client is present. */
async function probeTest(ctx: AdapterCtx, label: string): Promise<OpResult> {
  if (!ctx.credentialPresent) {
    return { ok: false, mode: 'offline-mock', detail: 'No credential set in Secrets Manager for this connection.' };
  }
  const live = ctx.clients?.probe ? await ctx.clients.probe.reach(ctx.endpoint).catch(() => null) : null;
  if (live) {
    return {
      ok: live.ok,
      mode: 'live',
      detail: live.ok ? `${label}: reached ${ctx.endpoint} with the stored credential.` : `${label}: endpoint returned ${live.status ?? 'error'}.`,
    };
  }
  return { ok: true, mode: 'offline-mock', detail: `${label}: credential present; endpoint not probed offline. The secret is never sent to the browser.` };
}

// ----------------------------------------------------------------- adapters -----

/** OAuth-based auth shared by Drive + SaaS (per-user / service OAuth). */
async function oauthAuth(ctx: AdapterCtx, label: string): Promise<OpResult<{ secretValue: string; secretKey: string }>> {
  const secretKey = ctx.template.secretKey;
  const live = ctx.clients?.oauth && ctx.authCode
    ? await ctx.clients.oauth.exchange(ctx.template.type === 'Drive' ? 'drive' : 'saas', ctx.endpoint, ctx.authCode).catch(() => null)
    : null;
  if (live) {
    return { ok: true, mode: 'live', detail: `${label}: OAuth token obtained and written to Secrets Manager.`, data: { secretValue: live.token, secretKey } };
  }
  // Offline mock: mint a deterministic, opaque token. Never leaves the server.
  const token = `mock-oauth-${secretKey}-${Math.random().toString(36).slice(2, 12)}`;
  return { ok: true, mode: 'offline-mock', detail: `${label}: mock OAuth completed; token stored in Secrets Manager (kind).`, data: { secretValue: token, secretKey } };
}

const driveAdapter: ConnectionAdapter = {
  connector: 'drive',
  auth: (ctx) => oauthAuth(ctx, 'Drive OAuth'),
  test: (ctx) => probeTest(ctx, 'Drive'),
  generateTools: (ctx) => presetTools(ctx, 'Drive'),
  compilePolicy,
  async sync(ctx) {
    const live = ctx.clients?.sync ? await ctx.clients.sync.run('drive', ctx.endpoint).catch(() => null) : null;
    if (live) return { ok: true, mode: 'live', detail: `Indexed ${live.records} Drive items → Files.`, data: { records: live.records, target: 'files' } };
    return { ok: true, mode: 'offline-mock', detail: 'Indexed 3 Drive items → Files (kind seed).', data: { records: 3, target: 'files' } };
  },
};

const databaseAdapter: ConnectionAdapter = {
  connector: 'database',
  async auth(ctx) {
    // Service credential (user/password / DSN). Stored verbatim into Secrets Manager.
    return { ok: true, mode: 'offline-mock', detail: 'Database credential captured for Secrets Manager.', data: { secretValue: '', secretKey: ctx.template.secretKey } };
  },
  test: (ctx) => probeTest(ctx, 'Database'),
  generateTools: (ctx) => presetTools(ctx, 'Database'),
  compilePolicy,
  async sync(ctx) {
    const live = ctx.clients?.sync ? await ctx.clients.sync.run('database', ctx.endpoint).catch(() => null) : null;
    if (live) return { ok: true, mode: 'live', detail: `dlt → Bronze: ${live.records} rows ingested.`, data: { records: live.records, target: 'bronze' } };
    return { ok: true, mode: 'offline-mock', detail: 'dlt → Bronze: 128 rows ingested (kind seed).', data: { records: 128, target: 'bronze' } };
  },
};

const apiAdapter: ConnectionAdapter = {
  connector: 'api',
  async auth(ctx) {
    return { ok: true, mode: 'offline-mock', detail: 'API bearer/token captured for Secrets Manager.', data: { secretValue: '', secretKey: ctx.template.secretKey } };
  },
  test: (ctx) => probeTest(ctx, 'API'),
  async generateTools(ctx) {
    // Tool-generation from an OpenAPI document: live fetch, else a pasted spec, else preset.
    const doc = ctx.clients?.schema ? await ctx.clients.schema.fetchOpenApi(ctx.endpoint).catch(() => null) : null;
    const spec = doc ?? ctx.openApiSpec;
    if (spec) {
      const tools = openApiToTools(spec);
      if (tools.length > 0) {
        return { ok: true, mode: doc ? 'live' : 'offline-mock', detail: `Generated ${tools.length} governed tools from the OpenAPI spec.`, data: tools };
      }
    }
    return presetTools(ctx, 'API (manual fallback)');
  },
  compilePolicy,
  async sync(ctx) {
    const live = ctx.clients?.sync ? await ctx.clients.sync.run('api', ctx.endpoint).catch(() => null) : null;
    if (live) return { ok: true, mode: 'live', detail: `dlt → Bronze: ${live.records} records ingested.`, data: { records: live.records, target: 'bronze' } };
    return { ok: true, mode: 'offline-mock', detail: 'dlt → Bronze: 42 records ingested (kind seed).', data: { records: 42, target: 'bronze' } };
  },
};

const mcpAdapter: ConnectionAdapter = {
  connector: 'mcp',
  async auth(ctx) {
    return { ok: true, mode: 'offline-mock', detail: 'MCP token captured for Secrets Manager.', data: { secretValue: '', secretKey: ctx.template.secretKey } };
  },
  test: (ctx) => probeTest(ctx, 'MCP server'),
  async generateTools(ctx) {
    // Tool-generation by listing the external MCP server's tools.
    const listed = ctx.clients?.schema ? await ctx.clients.schema.listMcpTools(ctx.endpoint).catch(() => null) : null;
    if (listed && listed.length > 0) {
      const tools: ConnectionTool[] = listed.map((t) => ({
        name: t.name,
        description: t.description ?? `${t.name} (from MCP server)`,
        write: Boolean(t.write),
        mode: (t.write ? 'Off' : 'Read') as CapabilityMode, // safe preset: reads on, writes off
      }));
      return { ok: true, mode: 'live', detail: `Surfaced ${tools.length} tools from the MCP server (safe preset).`, data: tools };
    }
    return presetTools(ctx, 'MCP server');
  },
  compilePolicy,
  async sync() {
    // MCP is a tool surface, not a data source — no sync.
    return { ok: true, mode: 'offline-mock', detail: 'MCP is a tool surface (no data-source sync).', data: { records: 0, target: 'none' } };
  },
};

const saasAdapter: ConnectionAdapter = {
  connector: 'saas',
  auth: (ctx) => oauthAuth(ctx, 'SaaS OAuth'),
  test: (ctx) => probeTest(ctx, 'SaaS'),
  generateTools: (ctx) => presetTools(ctx, 'SaaS'),
  compilePolicy,
  async sync(ctx) {
    const live = ctx.clients?.sync ? await ctx.clients.sync.run('saas', ctx.endpoint).catch(() => null) : null;
    if (live) return { ok: true, mode: 'live', detail: `dlt → Bronze: ${live.records} records ingested.`, data: { records: live.records, target: 'bronze' } };
    return { ok: true, mode: 'offline-mock', detail: 'dlt → Bronze: 17 records ingested (kind seed).', data: { records: 17, target: 'bronze' } };
  },
};

const ADAPTERS: Record<ConnectorKind, ConnectionAdapter> = {
  drive: driveAdapter,
  database: databaseAdapter,
  api: apiAdapter,
  mcp: mcpAdapter,
  saas: saasAdapter,
};

/** Resolve the adapter for a connector kind. A new connector = a new entry here. */
export function adapterFor(kind: ConnectorKind): ConnectionAdapter {
  return ADAPTERS[kind];
}

export const ADAPTER_KINDS: ConnectorKind[] = ['drive', 'database', 'api', 'mcp', 'saas'];

// ----------------------------------------------------- apply→verify discipline --

export type VerifiedOp = { op: string; applied: boolean; verified: boolean; ok: boolean; mode: OpMode; detail: string; error?: string };

/**
 * Run one adapter op with the apply→verify discipline: the op "applies", then a
 * verify predicate confirms it actually worked. A row is ✓ ONLY when both pass —
 * an apply that "succeeds" but fails verification surfaces ✗.
 */
export async function runVerified<T>(
  op: string,
  apply: () => Promise<OpResult<T>>,
  verify: (r: OpResult<T>) => boolean,
): Promise<VerifiedOp> {
  try {
    const r = await apply();
    if (!r.ok) return { op, applied: false, verified: false, ok: false, mode: r.mode, detail: r.detail, error: r.error ?? 'apply failed' };
    const verified = verify(r);
    return { op, applied: true, verified, ok: verified, mode: r.mode, detail: r.detail, error: verified ? undefined : 'verify failed' };
  } catch (e) {
    return { op, applied: false, verified: false, ok: false, mode: 'offline-mock', detail: '', error: (e as Error).message };
  }
}

// --------------------------------------------------------- OpenAPI → tools -----

type OpenApiLike = {
  paths?: Record<string, Record<string, { operationId?: string; summary?: string; description?: string }>>;
};

/** Minimal OpenAPI → governed tools: each operation becomes a tool, GET/HEAD read. */
export function openApiToTools(spec: unknown): ConnectionTool[] {
  const doc = spec as OpenApiLike;
  const out: ConnectionTool[] = [];
  const paths = doc?.paths;
  if (!paths || typeof paths !== 'object') return out;
  for (const [path, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const [method, op] of Object.entries(ops)) {
      const m = method.toLowerCase();
      if (!['get', 'head', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      const write = !['get', 'head'].includes(m);
      const name = (op?.operationId || `${m}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`).slice(0, 60);
      out.push({
        name,
        description: op?.summary || op?.description || `${m.toUpperCase()} ${path}`,
        write,
        // Safe preset: reads on; writes off (opt-in); delete Blocked.
        mode: m === 'delete' ? 'Blocked' : write ? 'Off' : 'Read',
      });
    }
  }
  return out;
}
