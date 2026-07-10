/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { resetPasswordWithRecovery } from '@/lib/platform-admin/users';
import { assessPasswordStrength } from '@/lib/core/password';
import { normalizeMasterKey } from '@/lib/platform-admin/recovery';
import { rateLimit, clientIp } from '@/lib/core/ratelimit';

export const dynamic = 'force-dynamic';

// Master-key guessing must be far harder than a login: 5 attempts / 15 min / IP.
const LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Public account recovery. Supplying the correct master key resets a chosen
 * account's password (strength enforced) and re-enables it. The key is only ever
 * compared against a server-side hash; it is never stored or echoed.
 */
export async function POST(req: Request) {
  let username = '';
  let key = '';
  let newPassword = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '').trim();
    key = normalizeMasterKey(String(body?.key ?? ''));
    newPassword = String(body?.newPassword ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Throttle per (IP, target account) so master-key guessing is limited without a
  // single shared bucket that could lock everyone out.
  const gate = rateLimit(`recover:${clientIp(req)}:${username.toLowerCase()}`, LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait and try again.' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } },
    );
  }

  if (!username || !key) {
    return NextResponse.json({ error: 'Username and recovery key are required' }, { status: 400 });
  }
  const strength = assessPasswordStrength(newPassword, username);
  if (!strength.ok) {
    return NextResponse.json({ error: strength.reasons[0] ?? 'Password is too weak', reasons: strength.reasons }, { status: 400 });
  }

  try {
    const user = await resetPasswordWithRecovery(username, key, newPassword);
    return NextResponse.json({ ok: true, user: { id: user.id } });
  } catch (e) {
    // Normalise to avoid leaking whether the key or the username was wrong.
    return NextResponse.json({ error: 'Recovery failed. Check the username and key.' }, { status: 401 });
  }
}
