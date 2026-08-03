/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { getPublicUser } from '@/lib/platform-admin/users';
import { type ScheduledReport, sendReport } from '@/lib/dashboards/reports';
import { deliverReport } from '@/lib/dashboards/delivery';

export const dynamic = 'force-dynamic';

/**
 * Send a scheduled report now (the demo/manual trigger; the scheduler calls the same
 * path on cadence). Advances `lastSentAt` AND actually delivers: persists an in-app
 * notification the recipient reads via the bell (in-app is the one delivery surface).
 * Governance: only a Builder+ may trigger a send (same rank that may promote/build).
 */
export const POST = withRoute<Record<string, string>, { report?: ScheduledReport }>(async ({ user, body }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'not permitted to send reports' }, { status: 403 });
  }
  if (!body.report) return NextResponse.json({ error: 'a report is required' }, { status: 400 });
  const { report, send } = sendReport(body.report, Date.now());
  const email = (await getPublicUser(user.id))?.email;
  const delivery = await deliverReport(report, { userId: user.id, email }, send.sentAt);
  return NextResponse.json({ ok: true, report, send, delivery });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });
