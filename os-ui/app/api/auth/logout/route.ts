/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { sessionCookieName, legacySessionCookieExpiries, sessionCookieOptions } from '@core/kernel/session';
import { toolSessionCookieExpiries } from '@core/infra/tool-proxy';
import { LOCALE_COOKIE } from '@core/i18n/config';

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
  // Expire every tool console's server-minted session (the LiteLLM UI session under
  // /tools/litellm/): a signed-out browser keeps no tool credential.
  for (const c of toolSessionCookieExpiries()) res.headers.append('Set-Cookie', c);
  // Clear the language mirror too: on a shared browser the sign-in page must not show the previous user's
  // language. The preference itself stays saved server-side and comes back at the next sign-in.
  res.cookies.set(LOCALE_COOKIE, '', sessionCookieOptions({ maxAge: 0 }));
  return res;
}
