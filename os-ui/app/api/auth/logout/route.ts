/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { sessionCookieName, legacySessionCookieExpiries, sessionCookieOptions } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear the host-only session cookie.
  res.cookies.set(
    sessionCookieName(),
    '',
    // Host-only (no Domain): the session cookie is sent to the OS host only.
    sessionCookieOptions({ maxAge: 0 }),
  );
  // Expire the legacy `soa_session` (host-only and on any parent Domain an older release used).
  for (const c of legacySessionCookieExpiries({ osPublicUrl: config.osPublicUrl, appsDomain: config.appsBaseDomain })) {
    res.headers.append('Set-Cookie', c);
  }
  return res;
}
