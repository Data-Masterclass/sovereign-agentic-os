/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { setSchedule } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** POST → set the system schedule (manual / cron / event). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const kind = body.kind === 'cron' || body.kind === 'event' ? body.kind : 'manual';
    const rec = setSchedule(id, user, {
      kind,
      cron: kind === 'cron' && typeof body.cron === 'string' ? body.cron : undefined,
      event: kind === 'event' && typeof body.event === 'string' ? body.event : undefined,
    });
    return NextResponse.json({ schedule: rec.schedule });
  } catch (e) {
    return fail(e);
  }
}
