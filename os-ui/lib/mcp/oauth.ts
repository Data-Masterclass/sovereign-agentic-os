/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/lib/core/config';
import { signMcpPayload } from '@/lib/mcp/token';
import { osMirror } from '@/lib/infra/os-mirror';

/**
 * OS-native OAuth 2.1 Authorization Server core for the MCP endpoint — the pure,
 * testable heart behind the `/oauth/*` + `/.well-known/*` route wrappers. os-ui
 * is BOTH the Authorization Server and the Resource Server on one origin, so the
 * access token it mints is the EXISTING `signMcpToken` envelope (via
 * `signMcpPayload`), enriched with `aud`/`exp`/`scope`. `resolveMcpUser` stays the
 * single identity/verification entry point; role + OPA/DLS are re-resolved LIVE on
 * every `/api/mcp` call — this layer only changes HOW the bearer arrives.
 *
 * Stores keep an authoritative in-process globalThis-pinned Map PLUS a best-effort
 * OpenSearch mirror (lib/os-mirror.ts) for the two pieces that MUST survive a pod
 * roll: DCR client registrations (`os-oauth-clients`) and refresh tokens
 * (`os-oauth-refresh`). Without this, every redeploy wiped the clients Map, so a
 * client_id Claude registered earlier became a permanent `invalid_client` on the
 * next authorize — breaking every student's MCP connection. Authorization `codes`
 * are deliberately NOT mirrored: they are 60s-lived + single-use, and persisting
 * them would only widen the replay window across the durability layer. The mirror
 * is best-effort: when it is down, auth gracefully falls back to in-memory and we
 * lose only cross-restart durability for that window (same as every other store).
 */

export const SCOPE = 'mcp:tools';
const CODE_TTL_SEC = 60; // authorization codes are short-lived + single-use
// 180-day access token: a cohort connects their AI tool ONCE and uses it across the
// whole program, so the connection must not drop mid-course (a 1h token dropped
// participants, and we can't rely on the client silently refreshing). Safe by design:
// the token is only an IDENTITY assertion — role + OPA + DLS are re-resolved LIVE on
// every /api/mcp call, so it never grants stale permissions; revocation is immediate
// via rotating the user's MCP secret. `expires_in` is reported so refresh still rotates.
const ACCESS_TTL_SEC = 15552000;

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

// ---- client-id metadata document (RFC-style; hosted Claude's default) -------
// Trusted origins whose https client_id URL we accept WITHOUT dynamic registration.
// These are the same first-party origins as the redirect allowlist.
const METADATA_DOC_ORIGINS = new Set(['https://claude.ai', 'https://claude.com']);
/**
 * When the client_id is an https URL to a client-metadata document (Claude's flow),
 * synthesize a public client bound to the presented redirect_uri — but ONLY if the
 * URL's origin is a trusted MCP-client origin. Returns undefined otherwise (so the
 * caller falls through to `invalid_client`). Security does NOT rest on trusting the
 * URL: the caller still enforces `isAllowedRedirect(redirectUri)` + PKCE S256, so the
 * code only reaches a Claude-controlled callback and only the verifier-holder redeems.
 */
function metadataDocumentClient(clientId: string, redirectUri: string): OAuthClient | undefined {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || !METADATA_DOC_ORIGINS.has(u.origin)) return undefined;
  return {
    clientId,
    redirectUris: [redirectUri],
    clientName: 'MCP client (client-id metadata document)',
    created: nowSec(),
  };
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
  // `clients` is ALWAYS a live, authoritative in-process Map (so a registration
  // survives even when the mirror is down). `clientsHydrated` flips true only
  // after a REACHABLE bulk hydrate merged the mirror's docs in; until then we
  // re-attempt on each access (so a recovered mirror self-heals). `clientsHydrating`
  // dedupes concurrent first-access hydrates behind one in-flight promise.
  clients: Map<string, OAuthClient>;
  clientsHydrated: boolean;
  clientsHydrating: Promise<void> | null;
  codes: Map<string, CodeEntry>;
  refresh: Map<string, RefreshEntry>;
};

const OAUTH_STATE_KEY = Symbol.for('soa.mcp.oauth');
function store(): OAuthStore {
  const g = globalThis as unknown as Record<symbol, OAuthStore | undefined>;
  if (!g[OAUTH_STATE_KEY]) {
    g[OAUTH_STATE_KEY] = {
      clients: new Map(),
      clientsHydrated: false,
      clientsHydrating: null,
      codes: new Map(),
      refresh: new Map(),
    };
  }
  return g[OAUTH_STATE_KEY]!;
}

// ---- durable mirrors (best-effort; in-process Map stays authoritative) ------
// Shared os-mirror core (probe → bootstrap-on-404 → hydrate/write/delete-through).
// Clients are keyed by their public clientId. Refresh tokens are keyed by the
// sha256 of the opaque token (never the raw token) so the doc id is fixed-length
// and no bearer secret is written to the mirror in the clear.
const CLIENTS_INDEX = 'os-oauth-clients';
const REFRESH_INDEX = 'os-oauth-refresh';
const clientsMirror = osMirror({ index: CLIENTS_INDEX });
const refreshMirror = osMirror({ index: REFRESH_INDEX });

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function isClientDoc(d: unknown): d is OAuthClient {
  if (!d || typeof d !== 'object') return false;
  const c = d as Partial<OAuthClient>;
  return typeof c.clientId === 'string' && Array.isArray(c.redirectUris);
}

/** Return the authoritative in-process clients Map, bulk-hydrating it from the
 *  mirror on first access so a fresh pod learns prior clients. The Map is never
 *  replaced — hydrate MERGES the mirror's docs into it (in-process registrations
 *  win) — and concurrent first-access calls share ONE in-flight hydrate. When the
 *  mirror is DOWN (`hydrate` → null) we do NOT mark it hydrated, so the next
 *  access retries once the mirror recovers (never a permanently-empty cache). */
async function getClientsMap(): Promise<Map<string, OAuthClient>> {
  const s = store();
  if (s.clientsHydrated) return s.clients;
  if (!s.clientsHydrating) {
    s.clientsHydrating = (async () => {
      const docs = await clientsMirror.hydrate(2000);
      if (docs === null) return; // mirror down → stay un-hydrated → retry next access
      for (const d of docs) {
        if (isClientDoc(d) && !s.clients.has(d.clientId)) s.clients.set(d.clientId, d);
      }
      s.clientsHydrated = true;
    })().finally(() => {
      s.clientsHydrating = null;
    });
  }
  await s.clientsHydrating;
  return s.clients;
}

/** Test-only: clear all OAuth in-memory state and reset the durable mirrors. */
export function __resetOAuth(): void {
  const s = store();
  s.clients = new Map();
  s.clientsHydrated = false;
  s.clientsHydrating = null;
  s.codes.clear();
  s.refresh.clear();
  clientsMirror.__reset();
  refreshMirror.__reset();
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- Dynamic Client Registration (RFC 7591) --------------------------------
export async function registerClient(input: {
  redirect_uris?: string[];
  client_name?: string;
}): Promise<OAuthClient> {
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
  const map = await getClientsMap();
  map.set(client.clientId, client); // authoritative in-process
  clientsMirror.writeThrough(client.clientId, client); // best-effort durability
  return client;
}
export async function getClient(clientId: string): Promise<OAuthClient | undefined> {
  const map = await getClientsMap();
  const hit = map.get(clientId);
  if (hit) return hit;
  // Miss: a pod that rolled AFTER this client registered may not have it in the
  // bulk hydrate window — read it through by id. null → missing or mirror down.
  const doc = await clientsMirror.getDoc(clientId);
  if (isClientDoc(doc)) {
    map.set(doc.clientId, doc);
    return doc;
  }
  return undefined;
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
export async function validateAuthorizeRequest(params: URLSearchParams): Promise<AuthorizeRequest> {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const method = params.get('code_challenge_method') ?? '';
  if (responseType !== 'code') {
    throw new OAuthError('unsupported_response_type', 'response_type must be "code"');
  }
  // Two client-identification flows are supported:
  //  (1) Dynamic Client Registration — clientId is a registered `soa_client_…`.
  //  (2) client-id metadata document (advertised via
  //      `client_id_metadata_document_supported`) — clientId is an https URL to the
  //      client's metadata doc (this is what hosted Claude uses). Accept it when its
  //      ORIGIN is a trusted MCP-client origin; the real protection is unchanged — the
  //      redirect_uri is still bound by isAllowedRedirect + PKCE S256 below, so the
  //      auth code can only land on a Claude-controlled callback and only the holder of
  //      the PKCE verifier can redeem it.
  const client = (await getClient(clientId)) ?? metadataDocumentClient(clientId, redirectUri);
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
  // tracked in-memory so it can be rotated (single-use) + client-bound. Also
  // mirrored (keyed by the token hash) so refresh survives a pod roll.
  // NOTE: mirror docs carry no TTL and are removed only on redemption, so the
  // index grows by orphaned rotations. Trivial at cohort scale (~36 users);
  // add an ILM/TTL sweep if this ever backs a large tenant.
  const token = signMcpPayload({ id: userId, typ: 'refresh', jti: randomToken(8) });
  store().refresh.set(token, { userId, clientId });
  refreshMirror.writeThrough(tokenId(token), { userId, clientId }); // best-effort durability
  return token;
}

export async function redeemRefreshToken(token: string, clientId: string): Promise<{ userId: string }> {
  const s = store();
  const id = tokenId(token);

  // Fast path — this pod issued the token. The whole branch is synchronous (no
  // await between get and delete), so single-use is atomic against a concurrent
  // redeem while still binding the client BEFORE consuming (a wrong client_id
  // must NOT burn the real client's token).
  const inMem = s.refresh.get(token);
  if (inMem) {
    if (inMem.clientId !== clientId) throw new OAuthError('invalid_grant', 'client_id mismatch');
    s.refresh.delete(token);
    refreshMirror.deleteThrough(id); // best-effort cleanup of the durable copy
    return { userId: inMem.userId };
  }

  // Miss — the token was issued on an earlier pod, so the mirror is the only
  // record. Read the entry to CLIENT-BIND (do not consume on a mismatch, so a
  // wrong client can't DoS the real one), then authorize rotation on the mirror's
  // OWN atomic delete — never on getDoc presence + a fire-and-forget delete, which
  // could resurrect the token if the delete was dropped (mirror blip / TOCTOU).
  const doc = (await refreshMirror.getDoc(id)) as RefreshEntry | null;
  if (!doc) throw new OAuthError('invalid_grant', 'refresh token is invalid or already used');
  if (doc.clientId !== clientId) throw new OAuthError('invalid_grant', 'client_id mismatch');
  const outcome = await refreshMirror.claim(id);
  // 'won' → we atomically deleted it → we alone may mint. 'lost' → already used by
  // a concurrent redeem. 'unreachable' → we cannot PROVE single-use, so reject
  // rather than risk a double-mint (Claude simply re-authorizes on the next 401).
  if (outcome !== 'won') throw new OAuthError('invalid_grant', 'refresh token is invalid or already used');
  return { userId: doc.userId };
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
