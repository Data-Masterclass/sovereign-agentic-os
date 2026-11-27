/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - app sign-in: the OS session becomes a one-time code for the app's registered callback
 * USER STORY: As a user opening an app built in the OS I sign in with my OS account and land back in the app.
 * ARCHITECTURE: Thin: `startAppLogin` (core/auth/app-login.ts) decides. No session ⇒ /signin and back here (303 to the
 *               public base); consent missing ⇒ the consent screen; else 302 to the registered callback with
 *               `code` + `state`. A request that cannot be trusted renders an error page and never redirects.
 *               Rate-limited per user and per client IP. `app_builder_disabled` while the App Builder is off.
 */
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { currentUser } from '@core/kernel/auth';
import { clientIp, rateLimit } from '@core/kernel/ratelimit';
import { startAppLogin } from '@core/auth/app-login';
import { appLoginErrorPage, loginDeps, osPublicBase } from '@core/auth/app-identity';
import { AppTokenUnavailable } from '@core/auth/app-token';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  const url = new URL(req.url);
  if (!rateLimit(`app-login:ip:${clientIp(req)}`, 60, 60_000).ok) return appLoginErrorPage('rate_limited', 429);
  const user = await currentUser();
  if (user && !rateLimit(`app-login:user:${user.id}`, 30, 60_000).ok) return appLoginErrorPage('rate_limited', 429, user.id);
  let outcome;
  try {
    outcome = await startAppLogin(url.searchParams, user, loginDeps());
  } catch (e) {
    if (e instanceof AppTokenUnavailable) return appLoginErrorPage('app_token_unavailable', 503, user?.id);
    throw e;
  }
  const base = osPublicBase(url.origin);
  switch (outcome.kind) {
    case 'signin':
      return Response.redirect(new URL(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, base).toString(), 303);
    case 'consent':
      return Response.redirect(new URL(`/api/auth/app-consent/screen?request=${encodeURIComponent(outcome.requestId)}`, base).toString(), 303);
    case 'redirect':
      return new Response(null, { status: 302, headers: { location: outcome.location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    case 'error':
      return appLoginErrorPage(outcome.error, outcome.status, user?.id);
  }
}
