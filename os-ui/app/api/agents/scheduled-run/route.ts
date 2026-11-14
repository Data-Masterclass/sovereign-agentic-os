/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { systemForScheduler, recordActivity } from '@tabs/agents/lib/store';
import { runScheduledSystem } from '@tabs/agents/lib/build/scheduled';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { scheduledSystemYaml } from '@tabs/agents/lib/lifecycle-adapter';

export const dynamic = 'force-dynamic';

/**
 * Scheduled-run trigger (CronJob-per-schedule). A schedule CronJob curls this with
 * the shared runtime bearer (no user session) and a systemId.
 *
 * The system is run LIVE, in-process, under the system OWNER's resolved live
 * identity — every governed tool call executes with exactly the owner's role +
 * domains (never a service principal, never escalated). A deleted/disabled owner
 * fails the run cleanly (409), never a service fallback.
 *
 * A5-review-L-1: there is no second path any more. A5 deleted `runSystem` and the
 * Python runtime with it, so a system whose grants map to no governed tool is a 400
 * NAMING those grants (`unmappedGrantNames`, deviation A5-4) — it is never quietly
 * routed to a weaker executor.
 *
 * LIFECYCLE (night 2, V-R2.2): a SCHEDULE runs the PINNED definition, read from the repo at
 * the live sha — not whatever the head happens to be when the CronJob fires. A system with no
 * pin, or a pin whose blob cannot be read, is REFUSED with the reason (`scheduledSystemYaml`);
 * it is never silently run from the head. Studio runs the head, through the run route.
 */
export async function POST(req: Request) {
  if (!runtimeTokenOk(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { systemId?: string; prompt?: string };
  const systemId = body.systemId;
  if (!systemId) return NextResponse.json({ error: 'systemId is required' }, { status: 400 });

  const rec = systemForScheduler(systemId);
  if (!rec) return NextResponse.json({ error: 'system not found' }, { status: 404 });

  const pinned = await scheduledSystemYaml(systemId);
  if (!pinned.ok) return NextResponse.json({ error: pinned.error }, { status: pinned.status });

  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Scheduled run';
  const outcome = await runScheduledSystem(systemId, { ...rec, yaml: pinned.yaml }, prompt);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  recordActivity(systemId);
  return NextResponse.json(outcome.report);
}
