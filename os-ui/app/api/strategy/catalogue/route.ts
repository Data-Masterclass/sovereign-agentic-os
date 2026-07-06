/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { METRIC_CATALOGUE } from '@/lib/strategy/pillars';
import { betCatalogue } from '@/lib/strategy/bets-bridge';

export const dynamic = 'force-dynamic';

/**
 * Picker data for the create/link UI: the governed business-value metrics a
 * pillar can link, the Big Bets it can attach, and the domains a domain-pillar
 * can be scoped to. RLS-scoped: a caller only sees domains + bets they are
 * entitled to (an Admin/platform user is tenant-wide), so the catalogue never
 * discloses cross-domain bet placement to a single-domain user.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({
      metrics: METRIC_CATALOGUE,
      // REAL bets the caller may see (canView) ∪ the worked-example stub seed.
      bets: betCatalogue(user).map((b) => ({
        id: b.id,
        name: b.name,
        domain: b.domain,
      })),
      // The domains a caller can scope a pillar to / filter by = their own.
      domains: [...user.domains].sort(),
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
