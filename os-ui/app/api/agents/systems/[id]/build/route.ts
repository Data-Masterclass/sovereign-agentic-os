/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystemForEdit } from '@/lib/agents/store';
import { buildSystem } from '@/lib/agents/build/server';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** POST → execute + verify the system across the 5 adapters; returns ✓/✗ rows. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    // Build executes the system + lands Langfuse traces (a side effect into
    // shared Monitoring), so it is edit-level, consistent with Run/Probe.
    const view = getSystemForEdit(id, user);
    const report = await buildSystem(id, view.yaml);
    return NextResponse.json(report);
  } catch (e) {
    return fail(e);
  }
}
