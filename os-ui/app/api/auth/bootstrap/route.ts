/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';
import { completeFirstLogin, getPublicUser, setupAdmin } from '@/lib/users';
import { assessPasswordStrength, hashPassword } from '@/lib/password';
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from '@/lib/session';

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
  if (!me) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const flags = await getPublicUser(me.id);
  if (!flags?.mustChangeCredentials) {
    return NextResponse.json({ error: 'Setup is not available for this account' }, { status: 409 });
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
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // The invited variant keeps its assigned username/email — only the password (and
  // optional display name) are set here. Strength is checked against the login id.
  const strengthLabel = isBootstrap ? username : me.id;
  if (isBootstrap && !username) {
    return NextResponse.json({ error: 'A username is required' }, { status: 400 });
  }
  const strength = assessPasswordStrength(password, strengthLabel);
  if (!strength.ok) {
    return NextResponse.json({ error: strength.reasons[0] ?? 'Password is too weak', reasons: strength.reasons }, { status: 400 });
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
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
    return res;
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
