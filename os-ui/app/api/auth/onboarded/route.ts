/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { markOnboarded } from '@/lib/platform-admin/users';

export const dynamic = 'force-dynamic';

/** Mark the signed-in user's first-login onboarding wizard as complete. */
export async function POST() {
  try {
    const me = await requireUser();
    await markOnboarded(me.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
