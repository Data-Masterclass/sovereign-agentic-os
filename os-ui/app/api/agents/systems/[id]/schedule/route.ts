/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { setSchedule } from '@/lib/agents/store';
import { reconcileScheduleCron, isValidCron } from '@/lib/agents/schedule-cron';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → set the system schedule (manual / cron / event).
 *
 * A `cron` schedule now ALSO provisions a real batch/v1 CronJob (the missing
 * trigger — the record alone never fires); clearing it (manual/event) deletes the
 * CronJob. `setSchedule` re-enforces edit-scope (owner or in-domain admin), so the
 * CronJob reconcile inherits that gate. The k8s result is returned HONESTLY: when
 * the cluster is unreachable the schedule is still persisted, but `cron.ok` is false
 * with an explanation — we never claim the CronJob exists when it does not.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const kind = body.kind === 'cron' || body.kind === 'event' ? body.kind : 'manual';
    const cron = kind === 'cron' && typeof body.cron === 'string' ? body.cron : undefined;
    if (kind === 'cron' && !isValidCron(cron)) {
      return NextResponse.json({ error: 'A cron schedule needs 5 fields, e.g. "0 9 * * 1".' }, { status: 400 });
    }
    const rec = setSchedule(id, user, {
      kind,
      cron,
      event: kind === 'event' && typeof body.event === 'string' ? body.event : undefined,
    });
    // Reconcile the real CronJob (create/update on cron, delete on manual/event).
    const cronStatus = await reconcileScheduleCron(id, rec.schedule);
    return NextResponse.json({ schedule: rec.schedule, cron: cronStatus });
  } catch (e) {
    return fail(e);
  }
}
