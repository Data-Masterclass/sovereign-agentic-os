/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { toggleAgent } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** POST → toggle one sub-agent on/off inside the system. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required.' }, { status: 400 });
    }
    const rec = toggleAgent(id, user, body.agentId, body.on !== false);
    return NextResponse.json({ disabledAgents: rec.disabledAgents });
  } catch (e) {
    return fail(e);
  }
}
