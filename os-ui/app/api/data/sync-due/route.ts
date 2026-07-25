/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { datasetsWithSync } from '@/lib/data/store';
import { runtimeTokenOk } from '@/lib/agents/build/runtime-auth';
import { runDatasetSync } from '@/lib/data/sync-run-server';
import { cronDueInWindow } from '@/lib/data/sync-cron';

export const dynamic = 'force-dynamic';

/** Default sweep window — must match (or exceed) the sweep CronJob's cadence so no
 *  slot falls between two sweeps. */
const DEFAULT_WINDOW_MINUTES = 15;

/**
 * POST /api/data/sync-due — the FALLBACK sync sweep (default OFF in the chart).
 *
 * The per-dataset CronJob (`data-sync-<datasetId>`, provisioned on save) is the
 * PRIMARY trigger. This sweep exists for clusters where os-ui may not manage
 * CronJobs: one chart-level CronJob (`dataSync.sweep.*`, cloned from the DQ sweep)
 * calls this route on a cadence, and every enabled sync whose cron fired within the
 * window runs — through the SAME executor, so lease/skip/quarantine semantics are
 * identical and a dataset triggered by BOTH paths simply records a 'skipped' row.
 *
 * Auth: the shared runtime bearer (service path) OR a signed-in builder+ (the same
 * gate the DQ run-all sweep enforces). Per-pipeline jitter spreads the Trino load
 * when many pipelines share a slot.
 */
export async function POST(req: Request) {
  if (!runtimeTokenOk(req.headers.get('authorization'))) {
    try {
      const user = await requirePrincipal(); // 401 for anon
      if (!roleAtLeast(user.role, 'builder')) {
        return NextResponse.json({ error: 'not permitted to run the sync sweep' }, { status: 403 });
      }
    } catch (e) {
      return errorResponse(e);
    }
  }

  const body = (await req.json().catch(() => ({}))) as { windowMinutes?: number };
  const windowMinutes =
    typeof body.windowMinutes === 'number' && body.windowMinutes >= 1 && body.windowMinutes <= 24 * 60
      ? body.windowMinutes
      : DEFAULT_WINDOW_MINUTES;
  const to = new Date();
  const from = new Date(to.getTime() - windowMinutes * 60_000);

  const due = datasetsWithSync().filter(
    (d) => d.sync!.enabled && cronDueInWindow(d.sync!.schedule.cron, from, to),
  );

  const results: { datasetId: string; status: string; detail?: string }[] = [];
  for (const d of due) {
    // Small per-pipeline jitter so a shared slot doesn't stampede Trino.
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2000)));
    const outcome = await runDatasetSync(d.id, 'schedule');
    if (!outcome.ok) results.push({ datasetId: d.id, status: 'refused', detail: outcome.error });
    else if (outcome.skipped) results.push({ datasetId: d.id, status: 'skipped', detail: outcome.reason });
    else results.push({ datasetId: d.id, status: outcome.run.status });
  }
  return NextResponse.json({ window: { from: from.toISOString(), to: to.toISOString() }, due: due.length, results });
}
