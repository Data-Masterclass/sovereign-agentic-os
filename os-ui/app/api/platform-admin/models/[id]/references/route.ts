/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { modelReferences } from '@/lib/platform-admin/model-references';
import { ensureHydrated as ensureAgentsHydrated } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * Where a model alias is in use — role pins, the assistant pin and agent per-node
 * pins. The Remove flow reads this BEFORE showing its confirm dialog so the admin
 * sees exactly what would break ("Used as: Standard role pin · …"). Admin-gated
 * like every Models & Providers surface.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await adminCtx();
    const { id } = await ctx.params;
    await ensureAgentsHydrated().catch(() => {}); // best-effort: sweep sees mirrored systems
    return NextResponse.json({ references: modelReferences(id) });
  } catch (e) {
    return fail(e);
  }
}
