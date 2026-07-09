/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getPillar, setTargets } from '@/lib/strategy/pillars';
import {
  type TargetSet,
  type AnnualQuarterly,
  ARTIFACT_KINDS,
  QUARTERS,
  emptyAnnualQuarterly,
} from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Coerce arbitrary input into a clean AnnualQuarterly (annual + 4 sub-targets). */
function coerceAQ(raw: unknown): AnnualQuarterly {
  const r = (raw ?? {}) as Record<string, unknown>;
  const annual = Number(r.annual);
  const out = emptyAnnualQuarterly(Number.isFinite(annual) ? annual : 0);
  const q = (r.quarterly ?? {}) as Record<string, unknown>;
  for (const k of QUARTERS) {
    const v = Number(q[k]);
    if (Number.isFinite(v)) out.quarterly[k] = v;
  }
  return out;
}

/** Set annual + quarterly targets for value, active people, and certified counts. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    // Authorize early (clear 403 before parsing the whole body).
    const pillar = await getPillar(user, id);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const certified = {} as TargetSet['certified'];
    for (const k of ARTIFACT_KINDS) certified[k] = coerceAQ(body?.certified?.[k]);

    const targets: TargetSet = {
      valueGenerated: coerceAQ(body?.valueGenerated),
      activeCreators: coerceAQ(body?.activeCreators),
      activeBuilders: coerceAQ(body?.activeBuilders),
      certified,
    };
    void pillar;
    const item = await setTargets(user, id, targets);
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}
