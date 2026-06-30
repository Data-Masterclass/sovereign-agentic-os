/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listPillars, getMetric } from '@/lib/bigbets/sources';

export const dynamic = 'force-dynamic';

/** GET → the Strategy pillars + their business metrics, to populate the create form. */
export async function GET() {
  try {
    await requireUser();
    const pillars = listPillars().map((p) => {
      const m = getMetric(p.metricId);
      return {
        id: p.id,
        name: p.name,
        scope: p.scope,
        metric: m ? { id: m.id, name: m.name, unit: m.unit } : null,
      };
    });
    return NextResponse.json({ pillars });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
