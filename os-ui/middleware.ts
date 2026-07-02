/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse, type NextRequest } from 'next/server';
import { config as appConfig } from '@/lib/config';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/**
 * Edge gate. Page navigations require a valid signed session (else → /signin).
 * API routes are allowed through and self-guard with `requireUser()` so they can
 * return a clean 401 JSON. The sign-in page + auth endpoints are always public.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always-public paths.
  if (
    pathname.startsWith('/signin') ||
    pathname.startsWith('/recover') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/icon.svg' ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // API routes AND the same-origin tool proxy guard themselves (return 401
  // JSON via requireUser()), so let them pass rather than redirecting — an
  // unauthenticated iframe should see a clean 401, not an HTML /signin page.
  if (pathname.startsWith('/api/') || pathname.startsWith('/tools/')) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = await verifySession(token, appConfig.sessionSecret);
  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals + static asset files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
