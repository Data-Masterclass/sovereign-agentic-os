/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { storeConnectionTokens } from '@/lib/connections';
import { asOAuthProvider } from '@/lib/oauth/providers';
import { exchangeCode } from '@/lib/oauth/client';
import { verifyState, nonceMatches, OAUTH_STATE_COOKIE } from '@/lib/oauth/state';
import { publicBaseUrl, callbackUri } from '@/lib/oauth/redirect';

export const dynamic = 'force-dynamic';

/**
 * OAuth redirect callback (registered redirect URI). Verifies the CSRF-signed
 * `state` against the double-submit nonce cookie AND the logged-in user, exchanges
 * the authorization code for tokens SERVER-SIDE, and persists the token set on the
 * connection's secret ref (Secrets Manager). Never renders the code, tokens, or any
 * secret; always lands the user back on the Files tab with a status flag.
 */
function landing(base: string, params: Record<string, string>): NextResponse {
  const to = new URL(`${base}/files`);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  const res = NextResponse.redirect(to.toString());
  res.cookies.delete(OAUTH_STATE_COOKIE); // one-time nonce
  return res;
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = asOAuthProvider(raw);
  const base = publicBaseUrl(req.url);
  if (!provider) return landing(base, { drive_error: 'unknown_provider' });

  const url = new URL(req.url);
  const providerError = url.searchParams.get('error');
  if (providerError) return landing(base, { drive_error: providerError });

  const code = url.searchParams.get('code') ?? '';
  const stateToken = url.searchParams.get('state') ?? '';
  if (!code || !stateToken) return landing(base, { drive_error: 'missing_code_or_state' });

  // CSRF: signature valid + not expired, provider matches, and the double-submit
  // nonce cookie matches the signed nonce.
  const state = await verifyState(stateToken, config.sessionSecret);
  const cookieNonce = req.headers.get('cookie')?.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`))?.[1];
  if (!state || state.provider !== provider || !nonceMatches(state.nonce, cookieNonce)) {
    return landing(base, { drive_error: 'invalid_state' });
  }

  // Bind the callback to the same signed-in user that started the flow.
  const user = await currentUser();
  if (!user || user.id !== state.userId) return landing(base, { drive_error: 'session_mismatch' });

  try {
    const redirectUri = callbackUri(base, provider); // MUST match the authorize step
    const tokens = await exchangeCode(provider, code, redirectUri);
    await storeConnectionTokens(state.connectionId, state.userId, tokens); // tokens → Secrets Manager only
    return landing(base, { drive_connected: provider });
  } catch (e) {
    // Never surface the code/tokens; a coarse reason is enough for the UI.
    const reason = (e as { status?: number })?.status === 409 ? 'not_configured' : 'exchange_failed';
    return landing(base, { drive_error: reason });
  }
}
