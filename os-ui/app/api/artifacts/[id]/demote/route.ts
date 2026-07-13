/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getArtifact } from '@/lib/core/artifacts';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/** Revoke sharing one step: Certified → Shared (admin) → Personal (owner/in-domain
 *  builder+). Runs THROUGH the governed demote seam (role + audit); the store fn
 *  re-enforces the gate. Never deletes the artifact — only lowers its tier. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await demoteThroughSeam('artifact', id, user);
    const item = await getArtifact(id);
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
