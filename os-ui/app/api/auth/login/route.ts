/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { authenticate } from '@/lib/auth';
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Credential login → signed session cookie. Passwords never leave the server. */
export async function POST(req: Request) {
  let username = '';
  let password = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '');
    password = String(body?.password ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const claims = await authenticate(username, password);
  if (!claims) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const token = await signSession(claims, config.sessionSecret);
  const res = NextResponse.json({ user: claims });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
