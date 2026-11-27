/**
 * FEATURE:    Every page of the app needs an OS sign-in.
 * USER STORY: As a user opening any page of the app without being signed in, I am taken through the OS sign-in and
 *             brought back to that page; when my session expires the same happens silently.
 * ARCHITECTURE: Pages only (the matcher skips /api, /os, Next internals and files). API routes answer 401 themselves
 *               through src/lib/os, so a client can decide to sign in again. The check is "is there a session
 *               cookie" (src/lib/os/session.ts); whether the token is still valid is decided by the OS on every call.
 */
import { needsSignIn, signInPath } from '@/lib/os/session';

export function middleware(request: Request): Response | undefined {
  if (request.method !== 'GET' || !needsSignIn(request)) return undefined;
  return Response.redirect(new URL(signInPath(request), request.url), 307);
}

export const config = {
  matcher: ['/((?!api/|os/|_next/|favicon.ico|.*\\..*).*)'],
};
