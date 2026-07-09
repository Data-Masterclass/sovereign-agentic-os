/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { getConnectionForUser } from '@/lib/connections';
import { asOAuthProvider, providerForTemplate, providerConfig } from '@/lib/oauth/providers';
import { getOAuthApp, isConfigured, ensureHydrated } from '@/lib/oauth/oauth-apps';
import { buildAuthorizeUrl } from '@/lib/oauth/token-set';
import { signState, newNonce, OAUTH_STATE_COOKIE } from '@/lib/oauth/state';
import { publicBaseUrl, callbackUri } from '@/lib/oauth/redirect';

export const dynamic = 'force-dynamic';

/**
 * Start the OAuth consent flow for a personal Drive/OneDrive connection. Validates
 * the caller OWNS the connection and it matches the provider, mints a CSRF-signed
 * `state` (+ a double-submit nonce cookie), and 302-redirects to the provider's
 * consent screen with the MINIMAL read scopes. The callback finishes the exchange.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = asOAuthProvider(raw);
  if (!provider) return NextResponse.json({ error: 'Unknown OAuth provider' }, { status: 400 });

  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!connectionId) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 });

    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    if (conn.owner !== user.id) return NextResponse.json({ error: 'Only the owner can connect this account' }, { status: 403 });
    if (providerForTemplate(conn.template) !== provider) {
      return NextResponse.json({ error: 'This connection does not use this OAuth provider' }, { status: 400 });
    }

    await ensureHydrated();
    if (!isConfigured(provider)) {
      return NextResponse.json({ error: `The ${provider} OAuth app is not configured by an administrator yet` }, { status: 409 });
    }
    const app = getOAuthApp(provider)!;

    const base = publicBaseUrl(req.url);
    const redirectUri = callbackUri(base, provider);
    const nonce = newNonce();
    const state = await signState({ connectionId, userId: user.id, provider, nonce }, config.sessionSecret);
    const authorizeUrl = buildAuthorizeUrl(providerConfig(provider), { clientId: app.clientId, redirectUri, state });

    const res = NextResponse.redirect(authorizeUrl);
    // Double-submit CSRF nonce: httpOnly, scoped to the OAuth callback path.
    res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: base.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/connections/oauth',
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
