/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { setComponentPlan, setOverride, removeComponent } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * PATCH → edit a component reference's plan (start/plannedReady/dependsOn/weight)
 * and/or its owner override (shown beside the derived state, never replacing it).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; ref: string }> }) {
  try {
    const user = await requireUser();
    const { id, ref } = await ctx.params;
    const b = await req.json().catch(() => ({}));
    const p = principal(user);
    if (b.override !== undefined) {
      setOverride(id, p, ref, b.override === null ? null : { note: b.override.note, asserts: b.override.asserts });
    }
    if (b.start || b.plannedReady || b.dependsOn || typeof b.weight === 'number') {
      setComponentPlan(id, p, ref, { start: b.start, plannedReady: b.plannedReady, dependsOn: b.dependsOn, weight: b.weight });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** DELETE → remove the component reference (untags the artifact; never deletes it). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; ref: string }> }) {
  try {
    const user = await requireUser();
    const { id, ref } = await ctx.params;
    removeComponent(id, principal(user), ref);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
