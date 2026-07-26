/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getPillar, setTargets } from '@/lib/strategy/pillars';
import {
  type TargetSet,
  type AnnualQuarterly,
  ARTIFACT_KINDS,
  QUARTERS,
  emptyAnnualQuarterly,
} from '@/lib/strategy';

export const dynamic = 'force-dynamic';

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
export const PUT = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
  const { id } = params;
  // Authorize early (clear 403 before parsing the whole body).
  const pillar = await getPillar(user, id);

  const b = body as {
    certified?: Record<string, unknown>;
    valueGenerated?: unknown;
    activeCreators?: unknown;
    activeBuilders?: unknown;
  };
  const certified = {} as TargetSet['certified'];
  for (const k of ARTIFACT_KINDS) certified[k] = coerceAQ(b?.certified?.[k]);

  const targets: TargetSet = {
    valueGenerated: coerceAQ(b?.valueGenerated),
    activeCreators: coerceAQ(b?.activeCreators),
    activeBuilders: coerceAQ(b?.activeBuilders),
    certified,
  };
  void pillar;
  const item = await setTargets(user, id, targets);
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });
