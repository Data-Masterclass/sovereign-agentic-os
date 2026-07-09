/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { forkSystem } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → install a Marketplace system as a fork-to-own independent copy.
 * The **Builder+** gate lives in `forkSystem` (the store is the security
 * boundary); a User/Creator is rejected (403), consistent with having no
 * Marketplace publish surface.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const rec = forkSystem(id, user);
    return NextResponse.json({ id: rec.id });
  } catch (e) {
    return fail(e);
  }
}
