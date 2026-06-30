/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { verifyEmailToken } from '@/lib/users';

export const dynamic = 'force-dynamic';

/**
 * Consume a single-use, expiring email-verification token. On success the
 * account is marked verified and the neutralised bootstrap `admin/admin`
 * tombstone is auto-deleted. Redirects back to the app with a status flag.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  const { ok } = await verifyEmailToken(token);
  const dest = new URL(ok ? '/?verified=1' : '/?verified=0', url.origin);
  return NextResponse.redirect(dest);
}
