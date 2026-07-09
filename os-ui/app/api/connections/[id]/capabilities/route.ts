/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { updateCapabilities } from '@/lib/connections';
import type { CapabilityMode, CapabilityLimits } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Update a connection's per-tool capability profile (Builder/Admin). Body:
 * { updates: [{ name, mode?, limits? }] }. Re-compiles into the OPA policy.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();
    const updates = Array.isArray(body?.updates)
      ? (body.updates as { name: string; mode?: CapabilityMode; limits?: CapabilityLimits }[])
      : [];
    if (updates.length === 0) return NextResponse.json({ error: 'No capability updates provided' }, { status: 400 });
    const connection = await updateCapabilities(id, user, updates);
    return NextResponse.json({ connection });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
