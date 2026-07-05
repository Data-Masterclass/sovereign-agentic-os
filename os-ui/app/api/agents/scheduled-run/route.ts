/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { systemForScheduler, recordActivity } from '@/lib/agents/store';
import { runScheduledSystem } from '@/lib/agents/build/scheduled';
import { runtimeTokenOk } from '@/lib/agents/build/runtime-auth';

export const dynamic = 'force-dynamic';

/**
 * Scheduled-run trigger (CronJob-per-schedule). A schedule CronJob curls this with
 * the shared runtime bearer (no user session) and a systemId.
 *
 * For an agentic-os LangGraph team the system is run LIVE, in-process, under the
 * system OWNER's resolved live identity — every governed tool call executes with
 * exactly the owner's role + domains (never a service principal, never escalated).
 * A deleted/disabled owner fails the run cleanly (409), never a service fallback.
 * Hermes / unmapped-legacy systems keep the runtime `runSystem` path ('scheduler').
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

  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Scheduled run';
  const outcome = await runScheduledSystem(systemId, rec, prompt);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  recordActivity(systemId);
  return NextResponse.json(outcome.report);
}
