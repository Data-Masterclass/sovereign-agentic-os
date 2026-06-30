/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { type ScheduledReport, sendReport } from '@/lib/dashboards/alerts';

export const dynamic = 'force-dynamic';

/**
 * Send a scheduled report now (the demo/manual trigger; the scheduler calls the same
 * path on cadence). Renders a snapshot of the dashboard and delivers it on the channel.
 * Returns the send record + the report with its `lastSentAt` advanced.
 */
export async function POST(req: Request) {
  try {
    await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { report?: ScheduledReport };
    if (!body.report) return NextResponse.json({ error: 'a report is required' }, { status: 400 });
    const { report, send } = sendReport(body.report, Date.now());
    return NextResponse.json({ ok: true, report, send });
  } catch (e) {
    return errorResponse(e);
  }
}
