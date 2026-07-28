/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse, type NextRequest } from 'next/server';
import { config as appConfig } from '@/lib/core/config';
import { SESSION_COOKIE, verifySession } from '@/lib/core/session';
import { corsHeadersFor } from '@/lib/core/cors';

/**
 * Edge gate. Page navigations require a valid signed session (else → /signin).
 * API routes are allowed through and self-guard with `requireUser()` so they can
 * return a clean 401 JSON. The sign-in page + auth endpoints are always public.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CREDENTIALED CORS for deployed governed apps calling back into the OS
  // (identity delegation: os.whoami() etc. from `<slug>.<domain>.<appsDomain>`).
  // Computed FIRST so it applies to EVERY governed surface — crucially including
  // the PUBLIC `/api/auth/me` the app SDK's os.whoami() hits BEFORE anything else
  // (it lives in the always-public block below; without this the credentialed
  // cross-origin whoami is blocked by the browser → "Load failed"). Reflect ONLY
  // recognised app/OS origins; same-origin calls carry no Origin and are untouched.
  const cors =
    pathname.startsWith('/api/') || pathname.startsWith('/tools/')
      ? corsHeadersFor(req.headers.get('origin'), appConfig.osPublicUrl, appConfig.appsBaseDomain)
      : null;
  // Answer the preflight uniformly (a public auth route or a self-guarded API route).
  if (cors && req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }
  const withCors = (res: NextResponse): NextResponse => {
    if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  // Always-public paths.
  if (
    pathname.startsWith('/signin') ||
    pathname.startsWith('/recover') ||
    pathname.startsWith('/api/auth') ||
    // OAuth managed-authorization surface. The discovery/metadata + register +
    // token endpoints must be reachable unauthenticated; /oauth/authorize
    // self-guards via currentUser() and does its OWN /signin bounce (preserving
    // the full query), so it must NOT be page-gated here.
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/_next') ||
    pathname === '/icon.svg' ||
    pathname === '/favicon.ico'
  ) {
    return withCors(NextResponse.next());
  }

  // API routes AND the same-origin tool proxy guard themselves (return 401
  // JSON via requireUser()), so let them pass rather than redirecting — an
  // unauthenticated iframe should see a clean 401, not an HTML /signin page.
  if (pathname.startsWith('/api/') || pathname.startsWith('/tools/')) {
    return withCors(NextResponse.next());
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = await verifySession(token, appConfig.sessionSecret);
  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  // Expose the request pathname to server layouts/pages (Next.js does not surface
  // it to a layout otherwise). The Platform-Admin layout reads it to keep every
  // /platform sub-page admin-only while the /platform overview is builder-visible.
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Run on everything except Next internals + static asset files (incl. the
  // self-hosted Monaco editor bundle under /monaco — never auth-gate it).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|monaco).*)'],
};
