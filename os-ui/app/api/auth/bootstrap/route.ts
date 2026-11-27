/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';
import { config } from '@core/kernel/config';
import { currentUser } from '@core/kernel/auth';
import { completeFirstLogin, getPublicUser, setupAdmin } from '@tabs/admin/lib/users';
import { assessPasswordStrength, hashPassword, issuesBody, weakPasswordMessage } from '@core/kernel/password';
import { sessionCookieName, SESSION_MAX_AGE, legacySessionCookieExpiries, sessionCookieOptions, signSession } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/**
 * Forced first-run / first-login setup. Two variants, both gated on the signed-in
 * user's `mustChangeCredentials` flag:
 *
 *  1. BOOTSTRAP ADMIN (the `admin/admin` row, `bootstrap`): sets a real username,
 *     email and STRONG password, DELETES the default `admin/admin` identity and
 *     AUTO-VERIFIES (the operator holding the bootstrap credential is trusted — no
 *     mailer needed). No email step can dead-end a fresh clone.
 *  2. INVITED USER (`mustChangeCredentials`, not bootstrap): signed in with the
 *     admin-issued one-time temp password, they set their OWN strong password
 *     (username/email/role stay fixed). This clears the flag, killing the temp
 *     credential.
 *
 * Either way the strong-password strength is enforced server-side and the caller
 * is re-signed into a fresh session (mustChangeCredentials is read live, so the
 * forced gate lifts immediately).
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return apiError(401, 'Not authenticated', 'auth.notAuthenticated');

  const flags = await getPublicUser(me.id);
  if (!flags?.mustChangeCredentials) {
    return apiError(409, 'Setup is not available for this account', 'onboarding.setupUnavailableForAccount');
  }
  const isBootstrap = Boolean(flags.bootstrap);

  let username = '';
  let email = '';
  let password = '';
  let name = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '').trim();
    email = String(body?.email ?? '').trim();
    password = String(body?.password ?? '');
    name = String(body?.name ?? '').trim();
  } catch {
    return apiError(400, 'Invalid JSON body', 'request.invalidJson');
  }

  // The invited variant keeps its assigned username/email — only the password (and
  // optional display name) are set here. Strength is checked against the login id.
  const strengthLabel = isBootstrap ? username : me.id;
  if (isBootstrap && !username) {
    return apiError(400, 'A username is required', 'users.usernameRequired');
  }
  const strength = assessPasswordStrength(password, strengthLabel);
  if (!strength.ok) {
    const weak = weakPasswordMessage(strength);
    return apiError(400, weak.english, weak.code, weak.params, { reasons: strength.reasons, issues: issuesBody(strength) });
  }

  try {
    const passwordHashReady = await hashPassword(password);
    const user = isBootstrap
      ? (await setupAdmin({ bootstrapId: me.id, username, name: name || undefined, email, passwordHashReady })).user
      : await completeFirstLogin(me.id, passwordHashReady, { name: name || undefined });

    // Re-issue the session (the name may have changed; the forced gate is lifted).
    const token = await signSession(
      { id: user.id, name: user.name, domains: user.domains, role: user.role },
      config.sessionSecret,
    );
    const res = NextResponse.json({ user });
    res.cookies.set(
      sessionCookieName(),
      token,
      // Host-only (no Domain): the session cookie is sent to the OS host only.
      sessionCookieOptions({ maxAge: SESSION_MAX_AGE }),
    );
    // Expire the legacy `soa_session` (host-only and on any parent Domain an older release used).
    for (const c of legacySessionCookieExpiries({ osPublicUrl: config.osPublicUrl, appsDomain: config.appsBaseDomain })) {
      res.headers.append('Set-Cookie', c);
    }
    return res;
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
