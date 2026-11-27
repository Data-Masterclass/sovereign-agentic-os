/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      The sign-in page explains a session cookie the browser did not keep
 * USER STORY:   As someone signing in on http://<server>:8080 (or a host the OS does not know), I want to read why I
 *               am back on the sign-in page and what fixes it, instead of the page silently reloading.
 * ARCHITECTURE: Pure (client-safe). The sign-in page calls `sessionProblem` after a 200 from /api/auth/login AND a
 *               /api/auth/me that still answers `user: null`, i.e. only when the session truly did not stick. It picks
 *               the `home.signin.*` message from the server's `sessionWarning` (core/kernel/session-transport.ts) and,
 *               when the server saw nothing, from the page's own location.
 */
import { isLoopbackHost, type SessionTransportWarning } from '@core/kernel/session-transport';

export type SessionProblem =
  | { key: 'signin.cookieNeedsHttps'; params: { origin: string } }
  | { key: 'signin.cookieWrongOrigin'; params: { origin: string; publicUrl: string } }
  | { key: 'signin.cookieNotKept'; params: { origin: string } };

function isWarning(w: unknown): w is SessionTransportWarning {
  if (!w || typeof w !== 'object') return false;
  const o = w as Record<string, unknown>;
  if (typeof o.origin !== 'string') return false;
  return o.kind === 'insecureHttp' || (o.kind === 'originMismatch' && typeof o.publicUrl === 'string');
}

/**
 * The message for a sign-in that succeeded but left no session.
 * @param serverWarning the login response's `sessionWarning` (anything; validated here)
 * @param location      the page's `window.location` (protocol, hostname, origin)
 */
export function sessionProblem(
  serverWarning: unknown,
  location: { protocol: string; hostname: string; origin: string },
): SessionProblem {
  if (isWarning(serverWarning)) {
    if (serverWarning.kind === 'insecureHttp') return { key: 'signin.cookieNeedsHttps', params: { origin: serverWarning.origin } };
    return { key: 'signin.cookieWrongOrigin', params: { origin: serverWarning.origin, publicUrl: serverWarning.publicUrl } };
  }
  if (location.protocol === 'http:' && !isLoopbackHost(location.hostname)) {
    return { key: 'signin.cookieNeedsHttps', params: { origin: location.origin } };
  }
  return { key: 'signin.cookieNotKept', params: { origin: location.origin } };
}
