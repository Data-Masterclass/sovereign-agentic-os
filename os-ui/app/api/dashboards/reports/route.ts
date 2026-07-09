/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { getPublicUser } from '@/lib/users';
import { type ScheduledReport, sendReport } from '@/lib/dashboards/reports';
import { deliverReport } from '@/lib/dashboards/delivery';

export const dynamic = 'force-dynamic';

/**
 * Send a scheduled report now (the demo/manual trigger; the scheduler calls the same
 * path on cadence). Advances `lastSentAt` AND actually delivers: emails the recipient
 * when a mailer is configured, else persists an in-app notification (never a no-op).
 * Governance: only a Builder+ may trigger a send (same rank that may promote/build).
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'not permitted to send reports' }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { report?: ScheduledReport };
    if (!body.report) return NextResponse.json({ error: 'a report is required' }, { status: 400 });
    const { report, send } = sendReport(body.report, Date.now());
    const email = (await getPublicUser(user.id))?.email;
    const delivery = await deliverReport(report, { userId: user.id, email }, send.sentAt);
    return NextResponse.json({ ok: true, report, send, delivery });
  } catch (e) {
    return errorResponse(e);
  }
}
