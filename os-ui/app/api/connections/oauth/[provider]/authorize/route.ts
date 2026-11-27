/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { getConnectionForUser, connectTarget, accountAuthorizeConfig } from '@tabs/connections/lib/index';
import { asOAuthProvider, providerForTemplate } from '@core/auth/providers';
import { getOAuthApp, isConfigured, ensureHydrated } from '@core/auth/oauth-apps';
import { buildAuthorizeUrl } from '@core/auth/token-set';
import { signState, newNonce, OAUTH_STATE_COOKIE } from '@core/auth/state';
import { publicBaseUrl, callbackUri, canonicalStartUrl, safeReturnTo } from '@core/auth/redirect';
import { apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';

export const dynamic = 'force-dynamic';

/**
 * Start the OAuth consent flow for a personal Drive/OneDrive connection. Validates
 * the caller OWNS the connection and it matches the provider, mints a CSRF-signed
 * `state` (+ a double-submit nonce cookie), and 302-redirects to the provider's
 * consent screen with the MINIMAL read scopes. The callback finishes the exchange.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  // Start on the canonical origin, so the nonce cookie and the callback share one origin (308).
  const canonical = canonicalStartUrl(req.url, req.headers.get('host'));
  if (canonical) return NextResponse.redirect(canonical, 308);

  const { provider: raw } = await ctx.params;
  const provider = asOAuthProvider(raw);
  if (!provider) return apiError(400, 'Unknown OAuth provider', 'connections.unknownOauthProvider');

  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!connectionId) return apiError(400, 'connectionId is required', 'connections.connectionIdRequired');

    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    // Per-user connection: anyone who can see it connects THEIR OWN account. Shared/legacy: the owner only.
    if (!connectTarget(conn, user)) return apiError(403, 'Only the owner can connect this account', 'connections.onlyOwnerConnects');
    if (providerForTemplate(conn.template) !== provider) {
      return apiError(400, 'This connection does not use this OAuth provider', 'connections.wrongOauthProvider');
    }

    await ensureHydrated();
    if (!isConfigured(provider)) {
      const vendor = provider === 'google' ? 'Google' : 'Microsoft';
      return apiError(409, `The ${vendor} sign-in app is not set up yet: an admin sets it up under Connections → Sign-in apps (Google & Microsoft)`, 'connections.signInAppMissing', { vendor });
    }
    const app = getOAuthApp(provider)!;

    const base = publicBaseUrl(req.url);
    const redirectUri = callbackUri(base, provider);
    const nonce = newNonce();
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    const state = await signState({ connectionId, userId: user.id, provider, nonce, ...(returnTo ? { returnTo } : {}) }, config.sessionSecret);
    // The connection's own scopes: its template's read set (Microsoft 365: mail, calendar, Teams, SharePoint),
    // plus Mail.ReadWrite + Mail.Send only when an admin allowed drafting and sending mail on it.
    const authorizeUrl = buildAuthorizeUrl(accountAuthorizeConfig(conn)!, { clientId: app.clientId, redirectUri, state });

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
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
