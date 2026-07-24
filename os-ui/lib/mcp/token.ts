/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@/lib/core/config';
import type { CurrentUser } from '@/lib/core/auth';
import { getPublicUser } from '@/lib/platform-admin/users';

/**
 * Per-user bearer token for the remote MCP endpoint (`/api/mcp`).
 *
 * The token is a compact, HMAC-SHA256-signed envelope `soa_mcp_<body>.<sig>`
 * where `body` is base64url(JSON{ id, iat }). It carries ONLY the user id — the
 * live role + domains are resolved from the user directory on every request, so
 * a role change, demotion or deletion takes effect immediately (the token is not
 * a frozen capability). It is signed with a SERVER-ONLY secret and never exposes
 * any secret to the client.
 *
 * MVP note: tokens are long-lived (no exp) so a one-time import into Claude /
 * ChatGPT keeps working. Rotation is by changing OS_MCP_TOKEN_SECRET (invalidates
 * all outstanding tokens). This is the seam an OAuth2 flow would replace later —
 * `resolveMcpUser()` stays the single entry point the route depends on.
 */

const PREFIX = 'soa_mcp_';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export type McpTokenPayload = {
  id: string;
  iat: number;
  /** OAuth access tokens: the MCP resource (`aud`) this token is bound to. */
  aud?: string;
  /** Expiry (epoch seconds). Absent = legacy long-lived token (no expiry check). */
  exp?: number;
  /** Coarse OAuth scope, e.g. `mcp:tools`. Advisory only — role is the authority. */
  scope?: string;
  /** `access` (default) or `refresh`. A refresh token is never a valid MCP bearer. */
  typ?: 'access' | 'refresh';
  /** Random nonce so two tokens minted in the same second differ. */
  jti?: string;
};

/**
 * Sign an arbitrary MCP token payload (`iat` is stamped if absent). This is the
 * single signing primitive; `signMcpToken` and the OAuth layer both build on it,
 * so the OAuth access token is the SAME envelope as the copy-paste bearer — only
 * enriched with `aud`/`exp`/`scope`/`typ`. Server-only.
 */
export function signMcpPayload(
  claims: Omit<McpTokenPayload, 'iat'> & { iat?: number },
  secret: string = config.mcpTokenSecret,
): string {
  const payload: McpTokenPayload = { iat: nowSec(), ...claims };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${PREFIX}${body}.${sig}`;
}

/** Mint a long-lived bearer token for a user id (the copy-paste path). Server-only. */
export function signMcpToken(id: string, secret: string = config.mcpTokenSecret): string {
  return signMcpPayload({ id }, secret);
}

/** Verify + decode a bearer token. Returns the payload, or null on any tamper. */
export function verifyMcpToken(
  token: string | undefined | null,
  secret: string = config.mcpTokenSecret,
): McpTokenPayload | null {
  if (!token) return null;
  const raw = token.startsWith(PREFIX) ? token.slice(PREFIX.length) : token;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as McpTokenPayload;
    if (!payload || typeof payload.id !== 'string' || !payload.id) return null;
    // Enforce expiry ONLY when present, so legacy no-exp tokens keep verifying.
    if (typeof payload.exp === 'number' && payload.exp <= nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Resolve a bearer token to the LIVE delegated identity, or null if the token is
 * invalid, the user no longer exists, or the account has not completed first-run
 * setup (the same gate `requireUser()` applies to the cookie session). This is
 * the ONLY authentication path the MCP route uses.
 */
export async function resolveMcpUser(token: string | undefined | null): Promise<CurrentUser | null> {
  const payload = verifyMcpToken(token);
  if (!payload || payload.typ === 'refresh') return null; // a refresh token is not an MCP bearer
  const u = await getPublicUser(payload.id);
  if (!u || u.mustChangeCredentials) return null;
  // MCP bearer (no browser cookie) ⇒ no active-domain narrowing: all domains.
  return { id: u.id, name: u.name, domains: u.domains, allDomains: u.domains, activeDomain: null, role: u.role };
}
