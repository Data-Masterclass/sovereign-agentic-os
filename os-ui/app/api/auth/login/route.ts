/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { authenticate } from '@/lib/auth';
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from '@/lib/session';
import { rateLimit, rateLimitReset, clientIp } from '@/lib/ratelimit';

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
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Throttle per (IP, target account): blunts guessing without letting one shared
  // bucket lock every user out, and without a constant key when XFF is absent.
  const key = `login:${clientIp(req)}:${username.trim().toLowerCase()}`;
  const gate = rateLimit(key, LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait and try again.' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } },
    );
  }

  const claims = await authenticate(username, password);
  if (!claims) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  rateLimitReset(key);
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
