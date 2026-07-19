/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { getModel, compilePredictPolicy, ensureModelsHydrated } from '@/lib/science';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/**
 * Personal → Domain → Marketplace for a model, running THROUGH the SAME governance
 * effect seam every other artifact uses (so the tab can reuse the shared
 * <PromoteButton>). A non-approver OWNER files a promotion REQUEST (approved by a
 * domain_admin+ in Governance) instead of being dead-ended; an approver promotes in
 * one shot. The rung is derived from the model's current tier. `model` in the path
 * is the registry name (e.g. `churn_model`).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ model: string }> }) {
  if (!config.mlEnabled) return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  try {
    const user = await requireUser();
    const { model } = await ctx.params;
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    const r = await promoteOrRequest('model', model, user);
    if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
    const m = getModel(model)!;
    return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/** The pending promotion request for this model (so the UI shows "awaiting approval"). */
export async function GET(_req: Request, ctx: { params: Promise<{ model: string }> }) {
  if (!config.mlEnabled) return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  try {
    await requireUser();
    const { model } = await ctx.params;
    const request =
      listApprovals({ status: 'pending' }).find(
        (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'model' && a.payload?.id === model,
      ) ?? null;
    return NextResponse.json({ request });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
