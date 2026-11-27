/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { apiError } from '@core/kernel/route-server';
import { errorBody } from '@core/kernel/server-message';
import { resetPasswordWithRecovery } from '@tabs/admin/lib/users';
import { assessPasswordStrength, issuesBody, weakPasswordMessage } from '@core/kernel/password';
import { normalizeMasterKey } from '@tabs/admin/lib/recovery';
import { rateLimit, clientIp } from '@core/kernel/ratelimit';

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
    return apiError(400, 'Invalid JSON body', 'request.invalidJson');
  }

  // Throttle per (IP, target account) so master-key guessing is limited without a
  // single shared bucket that could lock everyone out.
  const gate = rateLimit(`recover:${clientIp(req)}:${username.toLowerCase()}`, LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      errorBody('Too many attempts. Please wait and try again.', 'auth.tooManyAttempts'),
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } },
    );
  }

  if (!username || !key) {
    return apiError(400, 'Username and recovery key are required', 'auth.recoveryFieldsRequired');
  }
  const strength = assessPasswordStrength(newPassword, username);
  if (!strength.ok) {
    const weak = weakPasswordMessage(strength);
    return apiError(400, weak.english, weak.code, weak.params, { reasons: strength.reasons, issues: issuesBody(strength) });
  }

  try {
    const user = await resetPasswordWithRecovery(username, key, newPassword);
    return NextResponse.json({ ok: true, user: { id: user.id } });
  } catch (e) {
    // Normalise to avoid leaking whether the key or the username was wrong.
    return apiError(401, 'Recovery failed. Check the username and key.', 'auth.recoveryFailed');
  }
}
