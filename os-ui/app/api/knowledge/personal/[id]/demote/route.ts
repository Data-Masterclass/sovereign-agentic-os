/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { ensureHydrated } from '@/lib/knowledge/personal-store';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Revoke sharing on a personal ("My knowledge") entry one step DOWN the SAME
 * governed ladder every artifact rides:
 *   Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 * The rung is derived from the entry's current tier — never a silent jump. Never
 * deletes the entry; only lowers its visibility.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { id } = await ctx.params;
    const r = await demoteThroughSeam('personal_knowledge', id, user);
    return NextResponse.json({ ok: true, visibility: r.result.visibility, rung: r.rung });
  } catch (e) {
    return fail(e);
  }
}
