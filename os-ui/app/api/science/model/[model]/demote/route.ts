/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { getModel, compilePredictPolicy, ensureModelsHydrated } from '@/lib/science';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing one step — the mirror of ./promote, through the SAME governed
 * demote seam every other artifact uses: Marketplace → Domain (Admin) → Personal
 * (owner/in-domain Domain admin). Lowering the tier narrows who may call `predict`
 * automatically via the compiled policy; the model itself is never deleted.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ model: string }> }) {
  if (!config.mlEnabled) return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  try {
    const user = await requireUser();
    const { model } = await ctx.params;
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    await demoteThroughSeam('model', model, user);
    const m = getModel(model)!;
    return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
