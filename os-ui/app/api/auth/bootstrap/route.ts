/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';
import { getPublicUser, setupAdmin } from '@/lib/users';
import { assessPasswordStrength, hashPassword } from '@/lib/password';
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Forced first-run setup. Only callable by the signed-in bootstrap admin (the
 * `admin/admin` row, flagged mustChangeCredentials). Sets a real username, email
 * and STRONG password (strength enforced server-side), DELETES the default
 * `admin/admin` identity, AUTO-VERIFIES the account (the operator holding the
 * bootstrap credential is trusted — no mailer needed) and signs the operator
 * straight in as the new real admin. The instance is immediately usable; no
 * email step can dead-end a fresh clone.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const flags = await getPublicUser(me.id);
  if (!flags?.bootstrap || !flags?.mustChangeCredentials) {
    return NextResponse.json({ error: 'Setup is not available for this account' }, { status: 409 });
  }

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

  if (!username) return NextResponse.json({ error: 'A username is required' }, { status: 400 });
  const strength = assessPasswordStrength(password, username);
  if (!strength.ok) {
    return NextResponse.json({ error: strength.reasons[0] ?? 'Password is too weak', reasons: strength.reasons }, { status: 400 });
  }

  try {
    const passwordHashReady = await hashPassword(password);
    const { user } = await setupAdmin({
      bootstrapId: me.id,
      username,
      name: name || undefined,
      email,
      passwordHashReady,
    });

    // Re-issue the session as the new real admin.
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
