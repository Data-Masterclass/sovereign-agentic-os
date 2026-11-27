/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse, type NextRequest } from 'next/server';
import { config as appConfig } from '@core/kernel/config';
import {
  LEGACY_SESSION_COOKIE,
  legacySessionCookieExpiries,
  sessionTokenFrom,
  verifySession,
} from '@core/kernel/session';
import { corsHeadersFor } from '@core/kernel/cors';
import { checkSameOrigin, parseOriginList, requestOriginOf } from '@core/kernel/same-origin';
import { findDisabledTab } from '@core/kernel/tabs';
import { pageCspAppliesTo, pageCspHeaders } from '@core/kernel/csp';

/**
 * Edge gate. Page navigations require a valid signed session (else → /signin).
 * API routes are allowed through and self-guard with `requireUser()` so they can
 * return a clean 401 JSON. The sign-in page + auth endpoints are always public.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CORS: a credentialed grant ONLY for the OS's own public origin (exact match).
  // No other origin is ever reflected, so a page on another origin — including a
  // deployed app on the apps domain — cannot read OS API responses or pass a
  // non-simple preflight. Same-origin calls carry no cross-origin grant need.
  const cors =
    pathname.startsWith('/api/') || pathname.startsWith('/tools/')
      ? corsHeadersFor(req.headers.get('origin'), appConfig.osPublicUrl)
      : null;
  // The legacy `soa_session` is never read. Whenever a browser still sends one (an
  // old login, or a copy a parent-domain host planted), expire it on the response.
  const expireLegacy = req.cookies.has(LEGACY_SESSION_COOKIE)
    ? legacySessionCookieExpiries({ osPublicUrl: appConfig.osPublicUrl, appsDomain: appConfig.appsBaseDomain })
    : [];
  // Page CSP (core/kernel/csp.ts): enforced img-src/media-src, report-only for the rest.
  // Never on /api, /tools (proxied tools keep their own CSP) or /oauth.
  const csp = pageCspAppliesTo(pathname) ? pageCspHeaders(appConfig.appsBaseDomain) : null;
  const finish = (res: NextResponse): NextResponse => {
    for (const c of expireLegacy) res.headers.append('Set-Cookie', c);
    if (csp) for (const [k, v] of Object.entries(csp)) res.headers.set(k, v);
    return res;
  };
  const withCors = (res: NextResponse): NextResponse => {
    if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return finish(res);
  };
  // App Builder (workstream E): an app identity token is accepted only on the route allowlist, which the kernel
  // checks against the route THIS header names (core/kernel/auth.ts). Set here from the real request, overwriting
  // any client-sent value, for /api/* only and only while the App Builder is on. Off: `NextResponse.next()` exactly
  // as before.
  const passApi = (): NextResponse => {
    if (!appConfig.appBuilderEnabled || !pathname.startsWith('/api/')) return NextResponse.next();
    const headers = new Headers(req.headers);
    headers.delete('x-os-app-route');
    if (/^Bearer\s/i.test(req.headers.get('authorization') ?? '')) headers.set('x-os-app-route', `${req.method.toUpperCase()} ${pathname}`);
    return NextResponse.next({ request: { headers } });
  };
  const sessionToken = sessionTokenFrom((n) => req.cookies.get(n)?.value);
  // Answer the OS-origin preflight uniformly. Any other origin falls through and
  // gets no CORS headers, which the browser treats as a refusal.
  if (cors && req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // SAME-ORIGIN enforcement (CSRF): a request that carries the OS session cookie
  // must come from the OS's own origin before a state-changing method runs, and
  // before any admin read. Bearer-token / MCP / webhook clients carry no session
  // cookie and are unaffected. See core/kernel/same-origin.ts for the exact rules.
  const verdict = checkSameOrigin({
    method: req.method,
    pathname,
    headers: req.headers,
    hasSessionCookie: Boolean(sessionToken),
    osPublicUrl: appConfig.osPublicUrl,
    osPublicUrlAliases: parseOriginList(appConfig.osPublicUrlAliases),
    requestOrigin: requestOriginOf(req.nextUrl),
  });
  if (!verdict.ok) {
    return withCors(NextResponse.json({ error: 'forbidden', reason: verdict.reason }, { status: 403 }));
  }

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
    return withCors(passApi());
  }

  // API routes AND the same-origin tool proxy guard themselves (return 401
  // JSON via requireUser()), so let them pass rather than redirecting — an
  // unauthenticated iframe should see a clean 401, not an HTML /signin page.
  if (pathname.startsWith('/api/') || pathname.startsWith('/tools/')) {
    return withCors(passApi());
  }

  // Disabled-route guard: a tab hidden by OS_ENABLED_TABS must be truly
  // unreachable, not just hidden from the sidebar. Match the pathname
  // against the tab's href (exact for '/', prefix otherwise, so a sub-route
  // like /platform/settings is covered by the Admin tab's /platform) and
  // 404 honestly if that tab's feature isn't enabled in this deployment.
  const disabledTab = findDisabledTab(pathname, appConfig.enabledTabs);
  if (disabledTab) {
    return new NextResponse('Not found', { status: 404 });
  }

  const claims = await verifySession(sessionToken, appConfig.sessionSecret);
  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('next', pathname);
    return finish(NextResponse.redirect(url));
  }
  // Expose the request pathname to server layouts/pages (Next.js does not surface
  // it to a layout otherwise). The Platform-Admin layout reads it to keep every
  // /platform sub-page admin-only while the /platform overview is builder-visible.
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  return finish(NextResponse.next({ request: { headers } }));
}

export const config = {
  // Run on everything except Next internals + static asset files (incl. the
  // self-hosted Monaco editor bundle under /monaco — never auth-gate it).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|monaco).*)'],
};
