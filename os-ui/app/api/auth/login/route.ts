/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { apiError } from '@core/kernel/route-server';
import { errorBody } from '@core/kernel/server-message';
import { config } from '@core/kernel/config';
import { authenticate } from '@core/kernel/auth';
import { sessionCookieName, SESSION_MAX_AGE, legacySessionCookieExpiries, sessionCookieOptions, signSession } from '@core/kernel/session';
import { rateLimit, rateLimitReset, clientIp } from '@core/kernel/ratelimit';
import { diagnoseSessionTransport, warnSessionTransport } from '@core/kernel/session-transport';

export const dynamic = 'force-dynamic';

// Blunt online guessing: 10 attempts / 5 min per IP. A successful login resets it.
const LIMIT = 10;
const WINDOW_MS = 5 * 60 * 1000;

/** Credential login → signed session cookie. Passwords never leave the server. */
export async function POST(req: Request) {
  let username = '';
  let password = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '');
    password = String(body?.password ?? '');
  } catch {
    return apiError(400, 'Invalid JSON body', 'request.invalidJson');
  }

  // Throttle per (IP, target account): blunts guessing without letting one shared
  // bucket lock every user out, and without a constant key when XFF is absent.
  const key = `login:${clientIp(req)}:${username.trim().toLowerCase()}`;
  const gate = rateLimit(key, LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      errorBody('Too many attempts. Please wait and try again.', 'auth.tooManyAttempts'),
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } },
    );
  }

  let claims: Awaited<ReturnType<typeof authenticate>>;
  try {
    claims = await authenticate(username, password);
  } catch (err) {
    // The durable user directory is unreachable: say so honestly (503, retryable)
    // rather than a misleading "invalid password" — and never fall back to a seed.
    if ((err as { status?: number })?.status === 503) {
      return NextResponse.json(
        errorBody('User directory temporarily unavailable — please retry in a moment.', 'auth.directoryUnavailable'),
        { status: 503, headers: { 'retry-after': '5' } },
      );
    }
    throw err;
  }
  if (!claims) {
    return apiError(401, 'Invalid email or password', 'auth.invalidCredentials');
  }

  rateLimitReset(key);
  const token = await signSession(claims, config.sessionSecret);
  const cookieOptions = sessionCookieOptions({ maxAge: SESSION_MAX_AGE });
  // Never a silent bounce back to /signin: when the browser will not keep (or cannot use) the cookie — Secure over
  // plain HTTP on a non-localhost host, or an origin the OS does not know — log ONE line naming the fix and tell the
  // sign-in page, which confirms with /api/auth/me and shows the message. The cookie is still set: the verdict can
  // be wrong behind an unusual proxy, and then the session simply works.
  const transport = diagnoseSessionTransport({
    secureCookie: cookieOptions.secure,
    origin: req.headers.get('origin'),
    forwardedProto: req.headers.get('x-forwarded-proto'),
    requestUrl: req.url,
    osPublicUrl: config.osPublicUrl,
    osPublicUrlAliases: config.osPublicUrlAliases,
  });
  if (transport) warnSessionTransport(transport);
  const res = NextResponse.json(transport ? { user: claims, sessionWarning: transport } : { user: claims });
  res.cookies.set(
    sessionCookieName(),
    token,
    // Host-only (no Domain): the session cookie is sent to the OS host only.
    cookieOptions,
  );
  // Expire the legacy `soa_session` (host-only and on any parent Domain an older release used).
  for (const c of legacySessionCookieExpiries({ osPublicUrl: config.osPublicUrl, appsDomain: config.appsBaseDomain })) {
    res.headers.append('Set-Cookie', c);
  }
  return res;
}
