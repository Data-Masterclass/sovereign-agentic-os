/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear on the SAME Domain the session was set on, or a widened cookie survives.
  res.cookies.set(
    SESSION_COOKIE,
    '',
    sessionCookieOptions({
      osPublicUrl: config.osPublicUrl,
      appsDomain: config.appsBaseDomain,
      maxAge: 0,
    }),
  );
  return res;
}
