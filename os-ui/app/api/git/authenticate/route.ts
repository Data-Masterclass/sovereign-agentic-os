/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The ingress sub-request (`nginx.ingress.kubernetes.io/auth-url`) for every `/git/**` request.
 * A SHELL: `core/auth/git-http-auth.ts` decides, this file shapes HTTP. 200 ⇒ nginx forwards the
 * request to the `git-http` sidecar and copies `X-Os-Principal*` onto it; anything else is
 * returned to the client verbatim. The token never appears in a response or a log line — only its
 * public prefix does.
 */
import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@core/kernel/ratelimit';
import { principalById } from '@core/kernel/auth';
import { AUTH_FAILED, authenticateGitRequest } from '@core/auth/git-http-auth';
import { ensureHydrated } from '@core/auth/access-tokens-store';
import { ensureReceiveHooks } from '@core/infra/git-receive';
import { originalRequestUri } from '@core/infra/git-original-uri';

export const dynamic = 'force-dynamic';

/** Per-IP ceiling on token GUESSES. A git clone makes a handful of requests; a cracker makes
 *  thousands (review L-1). Generous enough that a busy CI job never notices. */
const AUTH_LIMIT = 120;
const AUTH_WINDOW_MS = 60_000;

async function decide(req: Request): Promise<NextResponse> {
  const limited = rateLimit(`git-auth:${clientIp(req)}`, AUTH_LIMIT, AUTH_WINDOW_MS);
  if (!limited.ok) {
    return new NextResponse('too many authentication attempts — try again shortly\n', {
      status: 429,
      headers: { 'retry-after': String(limited.retryAfter), 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  await ensureHydrated();
  // ingress-nginx sends X-Original-URL by default; X-Original-URI needed a snippet the STACKIT
  // controller forbids (allow-snippet-annotations=false). See core/infra/git-original-uri.ts.
  const uri = originalRequestUri(req.headers, req.url);
  const outcome = await authenticateGitRequest(
    { authorization: req.headers.get('authorization'), uri },
    { lookup: principalById },
  );
  if (!outcome.ok) {
    console.warn(`git-http: ${outcome.status} — ${outcome.logReason}`);
    return new NextResponse(outcome.message, {
      status: outcome.status,
      headers:
        outcome.status === 401
          ? { 'www-authenticate': 'Basic realm="Sovereign OS - use a personal access token"' /* ASCII only: header values are ByteStrings; an em-dash threw and turned every 401 into a 500 (0.9.1) */, 'content-type': 'text/plain; charset=utf-8' }
          : { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  // The push hooks live in the repo, and a repo can be created at any time by an OS write. Making
  // them current here costs a stat per request and means a brand-new repo is never pushable-but-
  // ungated.
  try {
    ensureReceiveHooks(outcome.target.domain);
  } catch (e) {
    console.warn(`git-http: could not install the receive hooks for ${outcome.target.domain}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return new NextResponse(null, {
    status: 200,
    headers: {
      'x-os-principal': outcome.principal.id,
      'x-os-principal-role': outcome.principal.role,
      'x-os-token-prefix': outcome.tokenPrefix,
    },
  });
}

export const GET = decide;
export const POST = decide;
export const HEAD = decide;
