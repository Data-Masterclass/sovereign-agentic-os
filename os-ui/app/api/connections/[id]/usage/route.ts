/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { enableDataUsage } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Register the connection as a DATA SOURCE (the second usage). Database/API/SaaS →
 * dlt → Bronze; Drive → Files. The connection stays a governed agent tool at the
 * same time — one object, two usages. Body: { usage?: 'bronze' | 'files' }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const usage = body?.usage === 'files' ? 'files' : body?.usage === 'bronze' ? 'bronze' : null;
    const connection = await enableDataUsage(id, user, usage);
    return NextResponse.json({ connection });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
