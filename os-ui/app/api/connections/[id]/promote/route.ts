/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { promoteConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Promote a connection one step: Personal → Shared (Builder/Admin) → Marketplace
 * (Admin only). Role-gated, domain-scoped, audited. A participant gets 403.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const connection = await promoteConnection(id, user);
    return NextResponse.json({ connection });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
