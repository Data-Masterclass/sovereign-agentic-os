/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { systemForScheduler, recordActivity } from '@/lib/agents/store';
import { runSystem } from '@/lib/agents/build/server';
import { runtimeTokenOk } from '@/lib/agents/build/runtime-auth';

export const dynamic = 'force-dynamic';

/**
 * Scheduled-run trigger (CronJob-per-schedule). A schedule CronJob curls this with
 * the shared runtime bearer (no user session) and a systemId; os-ui reloads + runs
 * the system through the runtime exactly like a manual Run — every tool call
 * governed + traced, writes held in Governance — attributed to 'scheduler'.
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

  const report = await runSystem(systemId, rec.yaml, {
    prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Scheduled run',
    requestedBy: 'scheduler',
    disabledAgents: rec.disabledAgents,
  });
  recordActivity(systemId);
  return NextResponse.json(report);
}
