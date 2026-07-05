/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/lib/config';
import { signMcpPayload } from '@/lib/mcp/token';

/**
 * OS-native OAuth 2.1 Authorization Server core for the MCP endpoint — the pure,
 * testable heart behind the `/oauth/*` + `/.well-known/*` route wrappers. os-ui
 * is BOTH the Authorization Server and the Resource Server on one origin, so the
 * access token it mints is the EXISTING `signMcpToken` envelope (via
 * `signMcpPayload`), enriched with `aud`/`exp`/`scope`. `resolveMcpUser` stays the
 * single identity/verification entry point; role + OPA/DLS are re-resolved LIVE on
 * every `/api/mcp` call — this layer only changes HOW the bearer arrives.
 *
 * Stores are in-memory + globalThis-pinned. os-ui runs `replicas:1`, so this is
 * correct + simplest; a restart just makes Claude re-register + re-auth on the
 * next 401 (silent to the user). Move to Valkey only if os-ui ever scales out.
 */

export const SCOPE = 'mcp:tools';
const CODE_TTL_SEC = 60; // authorization codes are short-lived + single-use
const ACCESS_TTL_SEC = 3600; // 1h access token; refresh rotates

// ---- origin-derived issuer / resource (RFC 8414 / RFC 9728) ----------------
// Read OS_PUBLIC_URL at call time (not module load) so it always reflects the
// live env (and tests can set it). Empty locally is fine — managed auth is a
// deploy-only surface.
function publicBase(): string {
  return (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
}
export function issuer(): string {
  return publicBase();
}
export function mcpResource(): string {
  return `${publicBase()}/api/mcp`;
}

// ---- typed OAuth error (RFC 6749 §5.2) -------------------------------------
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

// ---- redirect-URI allowlist -------------------------------------------------
// Hosted Claude surfaces (Desktop, claude.ai, mobile, Cowork) all use
// claude.ai/api/mcp/auth_callback (may migrate to claude.com — allow both). The
// Claude Code CLI uses a port-agnostic loopback /callback. Nothing else.
const STATIC_REDIRECTS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);
export function isAllowedRedirect(uri: string): boolean {
  if (STATIC_REDIRECTS.has(uri)) return true;
  try {
    const u = new URL(uri);
    if (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.pathname === '/callback'
    ) {
      return true;
    }
  } catch {
    /* not a URL */
  }
  return false;
}

// ---- in-memory, globalThis-pinned stores -----------------------------------
export type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  created: number;
};
type CodeEntry = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  exp: number;
};
type RefreshEntry = { userId: string; clientId: string };
type OAuthStore = {
  clients: Map<string, OAuthClient>;
  codes: Map<string, CodeEntry>;
  refresh: Map<string, RefreshEntry>;
};

const OAUTH_STATE_KEY = Symbol.for('soa.mcp.oauth');
function store(): OAuthStore {
  const g = globalThis as unknown as Record<symbol, OAuthStore | undefined>;
  if (!g[OAUTH_STATE_KEY]) {
    g[OAUTH_STATE_KEY] = { clients: new Map(), codes: new Map(), refresh: new Map() };
  }
  return g[OAUTH_STATE_KEY]!;
}

/** Test-only: clear all OAuth in-memory state. */
export function __resetOAuth(): void {
  const s = store();
  s.clients.clear();
  s.codes.clear();
  s.refresh.clear();
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- Dynamic Client Registration (RFC 7591) --------------------------------
export function registerClient(input: { redirect_uris?: string[]; client_name?: string }): OAuthClient {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (uris.length === 0) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required', 400);
  for (const u of uris) {
    if (!isAllowedRedirect(u)) throw new OAuthError('invalid_redirect_uri', `redirect_uri not allowed: ${u}`, 400);
  }
  const client: OAuthClient = {
    clientId: `soa_client_${randomToken(16)}`,
    redirectUris: uris,
    clientName: input.client_name,
    created: nowSec(),
  };
  store().clients.set(client.clientId, client);
  return client;
}
export function getClient(clientId: string): OAuthClient | undefined {
  return store().clients.get(clientId);
}

// ---- authorize-request validation (shared by GET render + POST consent) ----
export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  state?: string;
};
export function validateAuthorizeRequest(params: URLSearchParams): AuthorizeRequest {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const method = params.get('code_challenge_method') ?? '';
  if (responseType !== 'code') {
    throw new OAuthError('unsupported_response_type', 'response_type must be "code"');
  }
  const client = getClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'unknown client_id — register first');
  // A bad redirect_uri must NOT be redirected to (open-redirect / phishing).
  if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered / allowed');
  }
  if (!codeChallenge) throw new OAuthError('invalid_request', 'code_challenge is required (PKCE)');
  if (method !== 'S256') throw new OAuthError('invalid_request', 'code_challenge_method must be S256');
  return {
    clientId,
    redirectUri,
    codeChallenge,
    resource: params.get('resource') ?? undefined,
    scope: params.get('scope') || SCOPE,
    state: params.get('state') ?? undefined,
  };
}

// ---- authorization code (PKCE S256, single-use, short TTL) -----------------
export function issueCode(p: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
}): string {
  const code = randomToken(32);
  store().codes.set(code, {
    userId: p.userId,
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    resource: p.resource,
    scope: p.scope ?? SCOPE,
    exp: nowSec() + CODE_TTL_SEC,
  });
  return code;
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function redeemCode(
  code: string,
  check: { clientId: string; redirectUri: string; codeVerifier: string },
): { userId: string; scope: string } {
  const s = store();
  const entry = s.codes.get(code);
  if (!entry) throw new OAuthError('invalid_grant', 'authorization code is invalid or already used');
  s.codes.delete(code); // single-use: consume on ANY outcome
  if (entry.exp <= nowSec()) throw new OAuthError('invalid_grant', 'authorization code expired');
  if (entry.clientId !== check.clientId) throw new OAuthError('invalid_grant', 'client_id mismatch');
  if (entry.redirectUri !== check.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
  if (!verifyPkceS256(check.codeVerifier, entry.codeChallenge)) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed');
  }
  return { userId: entry.userId, scope: entry.scope };
}

// ---- access + refresh tokens -----------------------------------------------
// The access token IS the MCP bearer envelope (signMcpPayload), so resolveMcpUser
// verifies it unchanged. It carries only userId (+ aud/exp/scope) — role/domains
// are re-resolved live on every call.
export function issueAccessToken(
  userId: string,
  scope: string = SCOPE,
): { access_token: string; expires_in: number; scope: string } {
  const access_token = signMcpPayload({
    id: userId,
    typ: 'access',
    aud: mcpResource(),
    exp: nowSec() + ACCESS_TTL_SEC,
    scope,
    jti: randomToken(8),
  });
  return { access_token, expires_in: ACCESS_TTL_SEC, scope };
}

export function issueRefreshToken(userId: string, clientId: string): string {
  // Same signed envelope, marked typ:refresh (rejected by resolveMcpUser) and
  // tracked in-memory so it can be rotated (single-use) + client-bound.
  const token = signMcpPayload({ id: userId, typ: 'refresh', jti: randomToken(8) });
  store().refresh.set(token, { userId, clientId });
  return token;
}

export function redeemRefreshToken(token: string, clientId: string): { userId: string } {
  const s = store();
  const entry = s.refresh.get(token);
  if (!entry) throw new OAuthError('invalid_grant', 'refresh token is invalid or already used');
  if (entry.clientId !== clientId) throw new OAuthError('invalid_grant', 'client_id mismatch');
  s.refresh.delete(token); // rotate: the presented refresh token dies on use
  return { userId: entry.userId };
}

// ---- discovery metadata builders -------------------------------------------
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata() {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    // Advertise CIMD support (per the blocking-question mitigation); DCR remains
    // the live registration path.
    client_id_metadata_document_supported: true,
  };
}
