/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystem } from '@/lib/agents/store';
import { probeConnection } from '@/lib/agents/build/server';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → probe a granted connection (Task 6): granted Read → allow, non-granted →
 * deny, Write-approval → requires_approval (held in the Governance queue).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.connectionId !== 'string') {
      return NextResponse.json({ error: 'connectionId is required.' }, { status: 400 });
    }
    const view = getSystem(id, user);
    const result = await probeConnection(view.system, id, {
      connectionId: body.connectionId,
      write: body.write === true,
      requestedBy: user.id,
    });
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
