/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { registerWarehouseCatalog } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * ONE-CLICK REGISTER a warehouse connection as a live Trino catalog — merge its
 * .properties into the trino-catalog ConfigMap, materialize its secret(s) + wire the
 * Trino env, and roll the Trino Deployment. Builder/Admin with edit rights (re-gated in
 * the lib). The credential is read server-side and never returned; the response is the
 * honest per-step outcome (ok:false with the real reason on any rejection).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await registerWarehouseCatalog(id, user);
    // A registration the cluster rejected is a 502-shaped failure, surfaced honestly.
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
