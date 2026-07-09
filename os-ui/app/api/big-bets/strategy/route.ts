/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listPillars } from '@/lib/strategy/pillars';
import { canCreatePillar } from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

/**
 * GET → Strategy pillars + their value metrics, to populate the Big Bets create
 * form dropdown. Reads from the REAL strategy store (lib/strategy/pillars.ts —
 * globalThis-pinned, OpenSearch-mirrored, RLS-scoped) so the dropdown is never
 * empty when pillars exist.
 *
 * Response shape:
 *   { pillars: [{id, name, scope, metric}], canCreatePillar: boolean, userDomains: string[] }
 */
export async function GET() {
  try {
    const user = await requireUser();
    const rawPillars = await listPillars(user);

    const pillars = rawPillars.map((p) => {
      // Derive a display metric: prefer the pillar's described value metric (has
      // a human name); fall back to the first governed Cube metric link (title).
      const metricName = p.valueMetric?.name || p.metrics[0]?.title;
      // Use the Cube measure as a stable id (unique within tenant scope);
      // for value-metric-only pillars, synthesise one from the pillar id.
      const metricId = p.metrics[0]?.measure
        ?? (p.valueMetric?.name ? `vm_${p.id}` : null);
      return {
        id: p.id,
        name: p.name,
        scope: p.scope,
        metric: metricName && metricId
          ? { id: metricId, name: metricName, unit: '€' as const }
          : null,
      };
    });

    // Tell the UI whether this user may call POST /api/strategy/pillars.
    const canCreate =
      canCreatePillar(user, 'tenant', 'tenant') ||
      user.domains.some((d) => canCreatePillar(user, 'domain', d));

    return NextResponse.json({ pillars, canCreatePillar: canCreate, userDomains: user.domains });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
