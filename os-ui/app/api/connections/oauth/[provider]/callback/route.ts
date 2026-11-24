/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { completeAccountOAuth } from '@tabs/connections/lib/index';
import { asOAuthProvider } from '@core/auth/providers';
import { exchangeCode, accountSubject } from '@core/auth/client';
import { verifyState, nonceMatches, OAUTH_STATE_COOKIE } from '@core/auth/state';
import { publicBaseUrl, callbackUri, safeReturnTo } from '@core/auth/redirect';
import { FILES_LANDING_PATH, safeErrorCode } from '@core/auth/drive-landing';

export const dynamic = 'force-dynamic';

/**
 * OAuth redirect callback (registered redirect URI). Verifies the CSRF-signed
 * `state` against the double-submit nonce cookie AND the logged-in user, exchanges
 * the authorization code for tokens SERVER-SIDE, and persists the token set on the
 * connection's secret ref (Secrets Manager). Never renders the code, tokens, or any
 * secret; always lands the user back on the Files tab with a status flag.
 */
function landing(base: string, params: Record<string, string>, returnTo?: string | null): NextResponse {
  const to = new URL(`${base.replace(/\/+$/, '')}${safeReturnTo(returnTo) ?? FILES_LANDING_PATH}`);
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
  if (providerError) {
    // `error` alone is generic ('invalid_request'); the CODE in error_description
    // is what names the cause. Forward only a matched code, never the free text.
    const detail = safeErrorCode(url.searchParams.get('error_description') ?? '');
    return landing(base, detail ? { drive_error: providerError, drive_detail: detail } : { drive_error: providerError });
  }

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
  if (!user || user.id !== state.userId) return landing(base, { drive_error: 'session_mismatch' }, state.returnTo);

  try {
    const redirectUri = callbackUri(base, provider); // MUST match the authorize step
    const tokens = await exchangeCode(provider, code, redirectUri);
    const subject = await accountSubject(provider, tokens.accessToken); // "Connected as …" + audit; best-effort
    // Per-user connection → the caller's own sign-in; shared/legacy → the connection's. Vault only.
    await completeAccountOAuth(state.connectionId, state.userId, tokens, subject ? { subject } : {});
    return landing(base, { drive_connected: provider, connected: state.connectionId }, state.returnTo);
  } catch (e) {
    // Never surface the code/tokens; a coarse reason is enough for the UI.
    const reason = (e as { status?: number })?.status === 409 ? 'not_configured' : 'exchange_failed';
    // Keep the provider's code. `exchange_failed` on its own cannot distinguish a
    // mistyped client secret from an unreachable token endpoint.
    const detail = safeErrorCode(String((e as Error)?.message ?? ''));
    return landing(base, detail ? { drive_error: reason, drive_detail: detail } : { drive_error: reason }, state.returnTo);
  }
}
