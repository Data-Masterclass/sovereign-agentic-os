/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystem, setRunning } from '@/lib/agents/store';
import { runSystem } from '@/lib/agents/build/server';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → run a test invocation of the system through the governed gateway (every
 * tool call OPA-checked + Langfuse-traced), and flip the running flag. `stop:true`
 * just halts the system without an invocation.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    if (body.stop === true) {
      const rec = setRunning(id, user, false);
      return NextResponse.json({ running: rec.running });
    }

    const view = getSystem(id, user);
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Test invocation';
    const report = await runSystem(id, view.yaml, {
      prompt,
      requestedBy: user.id,
      disabledAgents: view.disabledAgents,
    });
    setRunning(id, user, true);
    return NextResponse.json({ running: true, ...report });
  } catch (e) {
    return fail(e);
  }
}
