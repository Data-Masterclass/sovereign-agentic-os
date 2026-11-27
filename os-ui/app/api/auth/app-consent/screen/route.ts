/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - the one-time consent screen of app sign-in, and the user's decision
 * USER STORY: As a user I read once what an app may do as me and allow or refuse it.
 * ARCHITECTURE: GET renders the OS-owned page for a pending login of THIS user (opaque id only); POST (same-origin
 *               form, checked by the edge middleware) records the decision through `decideAppConsent`: approve asks
 *               OPA here (`authorize` with `app_consent_write`, own record only) and is audited, then the login
 *               continues to the app's registered callback; deny returns `error=access_denied` to the app.
 *               `app_builder_disabled` while the App Builder is off.
 */
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { currentUser } from '@core/kernel/auth';
import { rateLimit } from '@core/kernel/ratelimit';
import { appConsentWriteDecision, authorize } from '@core/infra/governed';
import { consentScreenFor, decideAppConsent, type AuthorizeFn } from '@core/auth/app-login';
import { readPendingLogin } from '@core/auth/app-login-codes';
import { renderConsentPage } from '@core/auth/app-consent-page';
import { appIdentityLocale, appLoginErrorPage, consentDeps, htmlPage, loginDeps, osPublicBase, settingsT } from '@core/auth/app-identity';
import { AppTokenUnavailable } from '@core/auth/app-token';

export const dynamic = 'force-dynamic';

const SCREEN_PATH = '/api/auth/app-consent/screen';

function signinBounce(url: URL): Response {
  return Response.redirect(new URL(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, osPublicBase(url.origin)).toString(), 303);
}

export async function GET(req: Request): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  const url = new URL(req.url);
  const user = await currentUser();
  if (!user) return signinBounce(url);
  try {
    const screen = await consentScreenFor(url.searchParams.get('request') ?? '', user, loginDeps(), readPendingLogin);
    if (!screen) return appLoginErrorPage('consent_request_expired', 400, user.id);
    const locale = await appIdentityLocale(user.id);
    return htmlPage(renderConsentPage({ t: await settingsT(locale), lang: locale, app: screen.app, env: screen.pending.env, user, requestId: screen.pending.id, action: SCREEN_PATH }));
  } catch (e) {
    if (e instanceof AppTokenUnavailable) return appLoginErrorPage('app_token_unavailable', 503, user.id);
    throw e;
  }
}

export async function POST(req: Request): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  const url = new URL(req.url);
  const user = await currentUser();
  if (!user) return signinBounce(new URL(SCREEN_PATH, url));
  if (!rateLimit(`app-consent:user:${user.id}`, 20, 60_000).ok) return appLoginErrorPage('rate_limited', 429, user.id);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return appLoginErrorPage('consent_request_expired', 400, user.id);
  }
  const requestId = String(form.get('request') ?? '');
  const decision = form.get('decision') === 'approve' ? 'approve' : 'deny';
  const askOpa: AuthorizeFn = async (_kind, who, target) => {
    const a = await authorize(`user:${who.id}`, 'app.consent.grant', appConsentWriteDecision(who, 'grant', { app: target.app, env: target.env }));
    return { allowed: a.allowed, ...(a.decisionId ? { decisionId: a.decisionId } : {}), ...(a.policyRev ? { policyRev: a.policyRev } : {}) };
  };
  let outcome;
  try {
    outcome = await decideAppConsent(requestId, decision, user, { ...consentDeps(), authorize: askOpa });
  } catch (e) {
    if (e instanceof AppTokenUnavailable) return appLoginErrorPage('app_token_unavailable', 503, user.id);
    throw e;
  }
  switch (outcome.kind) {
    case 'redirect':
      return new Response(null, { status: 303, headers: { location: outcome.location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    case 'consent':
      return Response.redirect(new URL(`${SCREEN_PATH}?request=${encodeURIComponent(outcome.requestId)}`, osPublicBase(url.origin)).toString(), 303);
    case 'signin':
      return signinBounce(new URL(SCREEN_PATH, url));
    case 'error':
      return appLoginErrorPage(outcome.error, outcome.status, user.id);
  }
}
