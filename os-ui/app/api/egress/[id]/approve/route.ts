/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { decideEgress } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * An Administrator approves (or rejects) a Builder's egress request. Approving adds
 * the host to the allowlist so connections to it pass the egress check; all
 * outbound stays logged. Body: { decision?: 'approve' | 'reject' }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const decision = body?.decision === 'reject' ? 'reject' : 'approve';
    const r = decideEgress(id, decision, admin.id);
    if (!r) return NextResponse.json({ error: 'Egress request not found' }, { status: 404 });
    return NextResponse.json({ request: r });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
