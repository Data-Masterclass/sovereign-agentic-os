/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listDatasets } from '@/lib/data/store';
import { ensureHydrated, latestRun } from '@/lib/data/dq-results';
import { monitorId } from '@/lib/data/dq-monitors';
import { buildDqOverview, type DqDatasetInput } from '@/lib/monitoring/dq-overview';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/data-quality — the read-only tenant/domain DQ rollup (§5.2).
 *
 * Datasets ranked by risk (health · open failures · freshness), scoped to the viewer's
 * My/Domain/Company visibility (via `listDatasets`, which already applies the canView
 * gate + OS scope grouping). It reuses the persisted `dq-results` runs — no re-run, no
 * second store. Read-only: nothing here mutates. Anonymous ⇒ 401.
 *
 * `scope` is passed through so the client can offer the My/Domain/Company filter; the
 * server never returns out-of-scope datasets regardless of the filter chosen.
 */
export async function GET(req: Request) {
  try {
    const user = await requirePrincipal(); // 401 for anon
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope'); // 'my' | 'domain' | 'company' | null

    try {
      await ensureHydrated();
    } catch {
      /* the rollup degrades to "never run" rows rather than 5xx */
    }

    const groups = listDatasets(user);
    // My = personal · Domain = promoted assets · Company = certified products.
    let summaries = [...groups.mine, ...groups.domain, ...groups.marketplace];
    if (scope === 'my') summaries = groups.mine;
    else if (scope === 'domain') summaries = groups.domain;
    else if (scope === 'company') summaries = groups.marketplace;

    const inputs: DqDatasetInput[] = summaries.map((d) => {
      const run = latestRun(d.id);
      if (!run) return { id: d.id, name: d.name, owner: d.owner, domain: d.domain, latest: null };
      const openFailures = run.results.filter((r) => r.status === 'fail').length;
      const freshness = run.results.find((r) => r.id === monitorId('freshness'));
      return {
        id: d.id,
        name: d.name,
        owner: d.owner,
        domain: d.domain,
        latest: {
          ranAt: run.ranAt,
          badge: run.badge,
          healthScore: run.healthScore,
          openFailures,
          freshnessLate: freshness?.status === 'fail',
        },
      };
    });

    const overview = buildDqOverview(inputs);
    return NextResponse.json({ ...overview, scope: scope ?? 'all' });
  } catch (e) {
    return errorResponse(e);
  }
}
