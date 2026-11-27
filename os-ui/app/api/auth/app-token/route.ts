/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - the app server exchanges a one-time code (+ PKCE verifier) for an app identity token
 * USER STORY: As an app built in the OS I turn the user's sign-in into a short-lived token that lets me call the OS as
 *             that user, without ever holding a secret of my own.
 * ARCHITECTURE: POST `{ code, code_verifier, redirect_uri }` (JSON or form), called server-to-server over the cluster
 *               network. `exchangeAppCode` (core/auth/app-login.ts) redeems the code (single use, 60 s, PKCE, same
 *               redirect URI), re-reads the user and the app, re-checks consent; OPA is asked HERE (`authorize` with
 *               `app_token_issue`) before the token is minted. No session cookie is read or set; the token is only in
 *               the JSON body (`no-store`), never in a URL or a log. Rate-limited per client. `app_builder_disabled`
 *               while the App Builder is off.
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { clientIp, rateLimit } from '@core/kernel/ratelimit';
import { appTokenIssueDecision, authorize } from '@core/infra/governed';
import { exchangeAppCode, type AuthorizeFn } from '@core/auth/app-login';
import { exchangeDeps } from '@core/auth/app-identity';
import { AppTokenUnavailable } from '@core/auth/app-token';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

export async function POST(req: Request): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  if (!rateLimit(`app-token:ip:${clientIp(req)}`, 60, 60_000).ok) {
    return NextResponse.json({ error: 'slow_down', error_description: 'too many token requests' }, { status: 429, headers: NO_STORE });
  }
  const ctype = req.headers.get('content-type') ?? '';
  let body: unknown;
  if (ctype.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(await req.text()));
  } else {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid_request', error_description: 'the body must be JSON or a form' }, { status: 400, headers: NO_STORE });
    }
  }
  const askOpa: AuthorizeFn = async (_kind, who, target) => {
    const a = await authorize(`user:${who.id}`, 'app.token.issue', appTokenIssueDecision(who, { app: target.app, env: target.env, scope: target.scope ?? [] }));
    return { allowed: a.allowed, ...(a.decisionId ? { decisionId: a.decisionId } : {}), ...(a.policyRev ? { policyRev: a.policyRev } : {}) };
  };
  try {
    const r = await exchangeAppCode(body, exchangeDeps(askOpa));
    return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (e) {
    if (e instanceof AppTokenUnavailable) return NextResponse.json({ error: 'temporarily_unavailable', error_description: e.message }, { status: 503, headers: NO_STORE });
    throw e;
  }
}
