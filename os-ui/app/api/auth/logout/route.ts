/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { SESSION_COOKIE, legacySessionCookieExpiry, sessionCookieOptions } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear the host-only session cookie.
  res.cookies.set(
    SESSION_COOKIE,
    '',
    // Host-only (no Domain): the session cookie is sent to the OS host only.
    sessionCookieOptions({ maxAge: 0 }),
  );
  // Expire any session cookie an older release left on a parent Domain.
  const legacy = legacySessionCookieExpiry({ osPublicUrl: config.osPublicUrl, appsDomain: config.appsBaseDomain });
  if (legacy) res.headers.append('Set-Cookie', legacy);
  return res;
}
