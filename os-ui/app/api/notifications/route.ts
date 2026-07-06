/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, listNotifications } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user's in-app notifications (newest first). This is where report/alert
 * delivery lands when no mailer is configured — so a "send" is never a silent no-op:
 * the recipient can read it back here.
 */
export async function GET() {
  try {
    const user = await requirePrincipal();
    await ensureHydrated();
    return NextResponse.json({ notifications: listNotifications(user.id) });
  } catch (e) {
    return errorResponse(e);
  }
}
