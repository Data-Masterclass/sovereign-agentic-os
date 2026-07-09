/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { getConnectionForUser } from '@/lib/connections';
import { discoverMetadata, registerClient, buildNotionAuthorizeUrl } from '@/lib/oauth/notion-mcp';
import { createPkcePair } from '@/lib/oauth/pkce';
import { signState, newNonce, OAUTH_STATE_COOKIE } from '@/lib/oauth/state';
import { publicBaseUrl } from '@/lib/oauth/redirect';
import { putPendingFlow } from '@/lib/oauth/notion-flow';

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
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!connectionId) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 });

    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    if (conn.owner !== user.id) return NextResponse.json({ error: 'Only the owner can connect this account' }, { status: 403 });
    if (conn.template !== 'notion-mcp') {
      return NextResponse.json({ error: 'This connection is not a Notion MCP connection' }, { status: 400 });
    }

    const base = publicBaseUrl(req.url);
    const redirectUri = `${base.replace(/\/+$/, '')}${CALLBACK_PATH}`;

    // Discover endpoints + dynamically register a public client (no admin config).
    const meta = await discoverMetadata();
    const reg = await registerClient(meta, redirectUri);
    const pkce = await createPkcePair();
    const nonce = newNonce();
    const state = await signState({ connectionId, userId: user.id, provider: 'notion', nonce }, config.sessionSecret);

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
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
