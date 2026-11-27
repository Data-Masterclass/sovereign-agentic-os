/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@tabs/data/lib/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';
import { getPublicUser } from '@tabs/admin/lib/users';
import { type ScheduledReport, sendReport } from '@tabs/dashboards/lib/reports';
import { deliverReport } from '@tabs/dashboards/lib/delivery';

export const dynamic = 'force-dynamic';

/**
 * Post a report notice now (the manual trigger — no scheduler calls this; no cadence is
 * saved). Advances `lastSentAt` on the record it was handed AND persists one in-app
 * notification the recipient reads via the bell (in-app is the one delivery surface).
 * Governance: only a Builder+ may trigger a send (same rank that may promote/build).
 */
export const POST = withRoute<Record<string, string>, { report?: ScheduledReport }>(async ({ user, body }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return apiError(403, 'not permitted to send reports', 'dashboards.reportsNotPermitted');
  }
  if (!body.report) return apiError(400, 'a report is required', 'dashboards.reportRequired');
  const { report, send } = sendReport(body.report, Date.now());
  const email = (await getPublicUser(user.id))?.email;
  const delivery = await deliverReport(report, { userId: user.id, email }, send.sentAt);
  return NextResponse.json({ ok: true, report, send, delivery });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });
