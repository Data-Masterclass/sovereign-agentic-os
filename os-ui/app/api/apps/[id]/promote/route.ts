/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { promoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Promote an app (+ its data/files/connection) one step up the ladder:
 * Personal → Shared (Builder/Admin) → Marketplace (Admin only). The flip runs
 * THROUGH the governance effect seam (never a direct promoteApp — the former back
 * door is closed); the applier re-enforces role + domain. A non-Builder is 403.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await promoteThroughSeam('app', id, user);
    const app = await getAppForUser(id, user);
    return NextResponse.json({ app });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
