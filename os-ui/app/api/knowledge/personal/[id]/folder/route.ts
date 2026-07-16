/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { moveKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';

export const dynamic = 'force-dynamic';

/**
 * Move a personal knowledge entry into a folder. Runs AS the signed-in user;
 * `moveKnowledge` is edit-scoped (owner, in-domain domain_admin, or admin).
 *
 *   POST /api/knowledge/personal/:id/folder  { folder }  → move the entry
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { folder?: string };
    if (typeof body.folder !== 'string') {
      return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
    }
    const entry = moveKnowledge(id, user, body.folder);
    return NextResponse.json({ entry });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
