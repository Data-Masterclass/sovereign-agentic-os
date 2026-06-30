/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { publishAdapter, type Viewer } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/** Lineage-aware deprecate (admin, owning domain). Returns the warned importers. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAdmin();
    const { id } = await ctx.params;
    const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
    const result = await publishAdapter.deprecate(id, viewer);
    return NextResponse.json(result);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
