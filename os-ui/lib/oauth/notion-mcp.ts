/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  type TokenSet,
  type TokenResponse,
  tokenSetFromResponse,
} from './token-set.ts';

/**
 * The Notion HOSTED-MCP OAuth CLIENT — the OS acts as an MCP *client* that a user
 * authorizes to their own Notion workspace. Notion's hosted server at
 * `https://mcp.notion.com/mcp` speaks OAuth 2.1 with:
 *
 *   • RFC 9728 protected-resource metadata + RFC 8414 authorization-server metadata
 *     (we DISCOVER the authorize/token/registration endpoints — no hard-coding),
 *   • RFC 7591 Dynamic Client Registration (we register a PUBLIC client),
 *   • PKCE S256 (the code is bound to the browser that started the flow),
 *   • authorization_code + refresh_token grants.
 *
 * THE ONE RULE holds throughout: the access/refresh token set is a credential — it
 * is written only to Secrets Manager (by the caller) and NEVER returned to a
 * client, logged, or traced. This module only builds requests and parses
 * responses; `fetch` is injectable so every branch unit-tests against a fake.
 *
 * Liveness proof: once connected, `listNotionMcpTools` runs a real MCP
 * `initialize` + `tools/list` round-trip through the stored token, proving the
 * connection is live (not a mock).
 */

export const NOTION_MCP_ENDPOINT = 'https://mcp.notion.com/mcp';

/** Best-effort fallback endpoints when discovery is unreachable. Discovery wins. */
const NOTION_DEFAULTS: NotionMcpMetadata = {
  resource: NOTION_MCP_ENDPOINT,
  authorizeEndpoint: 'https://mcp.notion.com/authorize',
  tokenEndpoint: 'https://mcp.notion.com/token',
  registrationEndpoint: 'https://mcp.notion.com/register',
};

export type FetchFn = typeof fetch;

export type NotionMcpMetadata = {
  /** The MCP resource the token is audience-bound to (the /mcp endpoint). */
  resource: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
};

/**
 * The registered public client + the endpoints needed to refresh + call the
 * server. Persisted (server-side, in Secrets Manager) alongside the token so a
 * later refresh / tools-list does not need to re-discover or re-register.
 * `clientSecret` is normally absent (public client); when a provider returns one
 * it is a credential and is stored only in the vault.
 */
export type NotionClientReg = {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  mcpEndpoint: string;
  resource: string;
};

export type McpToolInfo = { name: string; description?: string };

function tagged(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

async function getJson(f: FetchFn, url: string, ms = 8000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await f(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw tagged(`GET ${url} returned ${res.status}`, 502);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(f: FetchFn, url: string, body: URLSearchParams, ms = 10000): Promise<TokenResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) throw tagged(`Token endpoint returned ${res.status}`, 502); // never echo the body
    return (await res.json()) as TokenResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- discovery ---

/**
 * Discover the authorize/token/registration endpoints from the MCP server's
 * well-known metadata (RFC 9728 → RFC 8414). Falls back to the documented Notion
 * endpoints if a metadata hop is unreachable, so the flow still starts.
 */
export async function discoverMetadata(opts: { fetchImpl?: FetchFn; mcpEndpoint?: string } = {}): Promise<NotionMcpMetadata> {
  const f = opts.fetchImpl ?? fetch;
  const mcp = opts.mcpEndpoint ?? NOTION_MCP_ENDPOINT;
  const origin = new URL(mcp).origin;

  // 1. protected-resource metadata → the authorization server base.
  let authServer = origin;
  try {
    const prm = await getJson(f, `${origin}/.well-known/oauth-protected-resource`);
    const servers = prm.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string') authServer = String(servers[0]).replace(/\/+$/, '');
  } catch { /* fall back to the MCP origin as the auth server */ }

  // 2. authorization-server metadata → the concrete endpoints.
  try {
    const asm = await getJson(f, `${authServer}/.well-known/oauth-authorization-server`);
    if (typeof asm.authorization_endpoint === 'string' && typeof asm.token_endpoint === 'string') {
      return {
        resource: mcp,
        authorizeEndpoint: asm.authorization_endpoint,
        tokenEndpoint: asm.token_endpoint,
        registrationEndpoint:
          typeof asm.registration_endpoint === 'string' ? asm.registration_endpoint : `${authServer}/register`,
      };
    }
  } catch { /* fall back to defaults below */ }

  return { ...NOTION_DEFAULTS, resource: mcp };
}

// ------------------------------------------------ Dynamic Client Registration ---

/** Register a PUBLIC OAuth client (RFC 7591). Returns the reg needed for the flow. */
export async function registerClient(
  meta: NotionMcpMetadata,
  redirectUri: string,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<NotionClientReg> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Sovereign Agentic OS',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — PKCE is the binding
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw tagged(`Notion dynamic client registration returned ${res.status}`, 502);
  const json = (await res.json()) as Record<string, unknown>;
  const clientId = typeof json.client_id === 'string' ? json.client_id : '';
  if (!clientId) throw tagged('Notion registration did not return a client_id', 502);
  return {
    clientId,
    clientSecret: typeof json.client_secret === 'string' && json.client_secret ? json.client_secret : undefined,
    tokenEndpoint: meta.tokenEndpoint,
    mcpEndpoint: meta.resource,
    resource: meta.resource,
  };
}

// ------------------------------------------------------------ authorize URL ---

/** Build the Notion consent URL (PKCE S256 + resource binding). PURE. */
export function buildNotionAuthorizeUrl(
  meta: NotionMcpMetadata,
  input: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const u = new URL(meta.authorizeEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', input.clientId);
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('code_challenge', input.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', input.state);
  if (meta.resource) u.searchParams.set('resource', meta.resource);
  return u.toString();
}

// ------------------------------------------------------- token exchange/refresh ---

/** Exchange the authorization code (+ PKCE verifier) for a token set. */
export async function exchangeNotionCode(
  reg: NotionClientReg,
  input: { code: string; redirectUri: string; codeVerifier: string },
  opts: { fetchImpl?: FetchFn; now?: number } = {},
): Promise<TokenSet> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: reg.clientId,
    code_verifier: input.codeVerifier,
  });
  if (reg.clientSecret) body.set('client_secret', reg.clientSecret);
  if (reg.resource) body.set('resource', reg.resource);
  const json = await postForm(f, reg.tokenEndpoint, body);
  const ts = tokenSetFromResponse(json, opts.now ?? Math.floor(Date.now() / 1000));
  if (!ts) throw tagged('Notion token endpoint did not return an access token', 502);
  return ts;
}

/** Silent refresh of an expiring Notion access token. Throws → mark needs-reconnect. */
export async function refreshNotionToken(
  reg: NotionClientReg,
  prev: TokenSet,
  opts: { fetchImpl?: FetchFn; now?: number } = {},
): Promise<TokenSet> {
  if (!prev.refreshToken) throw tagged('No refresh token stored; Notion must be reconnected', 401);
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: prev.refreshToken,
    client_id: reg.clientId,
  });
  if (reg.clientSecret) body.set('client_secret', reg.clientSecret);
  if (reg.resource) body.set('resource', reg.resource);
  const json = await postForm(f, reg.tokenEndpoint, body);
  const ts = tokenSetFromResponse(json, opts.now ?? Math.floor(Date.now() / 1000), prev);
  if (!ts) throw tagged('Notion refresh did not return an access token', 502);
  return ts;
}

// --------------------------------------------------- MCP initialize + tools/list ---

/** Parse a Streamable-HTTP MCP response — a JSON body, or `data:` SSE frames. */
function parseRpcBody(contentType: string, text: string): Record<string, unknown> | null {
  if (contentType.includes('text/event-stream')) {
    // Take the last `data:` line's JSON payload.
    let last: Record<string, unknown> | null = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { last = JSON.parse(payload) as Record<string, unknown>; } catch { /* skip */ }
    }
    return last;
  }
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

type RpcResult = { body: Record<string, unknown> | null; sessionId: string | null };

async function mcpRpc(
  f: FetchFn,
  endpoint: string,
  accessToken: string,
  message: Record<string, unknown>,
  sessionId: string | null,
  ms = 10000,
): Promise<RpcResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await f(endpoint, { method: 'POST', headers, body: JSON.stringify(message), cache: 'no-store', signal: ctrl.signal });
    const sid = res.headers.get('mcp-session-id');
    // A notification (no id) yields 202 with no body — that is success.
    if (message.id === undefined) return { body: null, sessionId: sid ?? sessionId };
    if (!res.ok) throw tagged(`MCP endpoint returned ${res.status}`, 502);
    const text = await res.text();
    return { body: parseRpcBody(res.headers.get('content-type') ?? '', text), sessionId: sid ?? sessionId };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove liveness: run a real MCP `initialize` → `notifications/initialized` →
 * `tools/list` round-trip through the stored access token and return the server's
 * advertised tool names. Throws on transport/auth failure so the caller can
 * surface "needs reconnect". The token is used ONLY as the bearer here — never
 * returned to the client.
 */
export async function listNotionMcpTools(
  reg: NotionClientReg,
  accessToken: string,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<McpToolInfo[]> {
  const f = opts.fetchImpl ?? fetch;
  const init = await mcpRpc(f, reg.mcpEndpoint, accessToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'sovereign-agentic-os', version: '1.0' },
    },
  }, null);
  const sessionId = init.sessionId;
  // Best-effort initialized notification (some servers require it before tools/list).
  await mcpRpc(f, reg.mcpEndpoint, accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => undefined);
  const listed = await mcpRpc(f, reg.mcpEndpoint, accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  const result = listed.body?.result as { tools?: unknown } | undefined;
  const tools = result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .map((t) => ({ name: String(t.name ?? ''), description: typeof t.description === 'string' ? t.description : undefined }))
    .filter((t) => t.name);
}

// --------------------------------------------------- client-reg (de)serialize ---

/** Serialize the client reg for Secrets Manager (server-side only). */
export function serializeClientReg(reg: NotionClientReg): string {
  return JSON.stringify(reg);
}

export function parseClientReg(raw: string | null | undefined): NotionClientReg | null {
  if (!raw || typeof raw !== 'string' || !raw.trim().startsWith('{')) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.clientId !== 'string' || !o.clientId) return null;
    if (typeof o.tokenEndpoint !== 'string' || typeof o.mcpEndpoint !== 'string') return null;
    return {
      clientId: o.clientId,
      clientSecret: typeof o.clientSecret === 'string' ? o.clientSecret : undefined,
      tokenEndpoint: o.tokenEndpoint,
      mcpEndpoint: o.mcpEndpoint,
      resource: typeof o.resource === 'string' ? o.resource : o.mcpEndpoint,
    };
  } catch {
    return null;
  }
}
