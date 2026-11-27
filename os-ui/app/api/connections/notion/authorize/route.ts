/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { getConnectionForUser, connectTarget } from '@tabs/connections/lib/index';
import { discoverMetadata, registerClient, buildNotionAuthorizeUrl } from '@core/auth/notion-mcp';
import { createPkcePair } from '@core/auth/pkce';
import { signState, newNonce, OAUTH_STATE_COOKIE } from '@core/auth/state';
import { publicBaseUrl, canonicalStartUrl, safeReturnTo } from '@core/auth/redirect';
import { putPendingFlow } from '@core/auth/notion-flow';
import { apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';

export const dynamic = 'force-dynamic';

const CALLBACK_PATH = '/api/connections/notion/callback';

/**
 * Start the Notion hosted-MCP OAuth flow for a personal connection. Validates the
 * caller OWNS a `notion-mcp` connection, DISCOVERS the auth endpoints + dynamically
 * REGISTERS a public client, mints a PKCE pair + CSRF-signed `state` (+ nonce
 * cookie), stashes the PKCE verifier server-side, and 302-redirects to Notion's
 * consent screen. The callback finishes the code→token exchange.
 */
export async function GET(req: Request) {
  // Start on the canonical origin, so the nonce cookie and the callback share one origin (308).
  const canonical = canonicalStartUrl(req.url, req.headers.get('host'));
  if (canonical) return NextResponse.redirect(canonical, 308);
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!connectionId) return apiError(400, 'connectionId is required', 'connections.connectionIdRequired');

    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    // Per-user connection: anyone who can see it connects THEIR OWN Notion. Shared/legacy: the owner only.
    if (!connectTarget(conn, user)) return apiError(403, 'Only the owner can connect this account', 'connections.onlyOwnerConnects');
    if (conn.template !== 'notion-mcp') {
      return apiError(400, 'This connection is not a Notion MCP connection', 'connections.notNotionMcp');
    }

    const base = publicBaseUrl(req.url);
    const redirectUri = `${base.replace(/\/+$/, '')}${CALLBACK_PATH}`;

    // Discover endpoints + dynamically register a public client (no admin config).
    const meta = await discoverMetadata();
    const reg = await registerClient(meta, redirectUri);
    const pkce = await createPkcePair();
    const nonce = newNonce();
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    const state = await signState({ connectionId, userId: user.id, provider: 'notion', nonce, ...(returnTo ? { returnTo } : {}) }, config.sessionSecret);

    // The PKCE verifier is a secret — held server-side, never placed in the URL.
    putPendingFlow(nonce, { connectionId, userId: user.id, verifier: pkce.verifier, reg, redirectUri });

    const authorizeUrl = buildNotionAuthorizeUrl(meta, {
      clientId: reg.clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: base.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/connections',
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
