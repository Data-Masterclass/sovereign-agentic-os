/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, builtLayerFqn } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import { ensureHydrated, healthTrend, latestRun } from '@/lib/data/dq-results';
import { suggestChecks } from '@/lib/data/dq-suggest';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type Profile,
  type ProfileColumn,
} from '@/lib/data/profile';

export const dynamic = 'force-dynamic';

const MAX_TOPVALUE_COLUMNS = 40;

/**
 * The Validate-stage Data-Quality surface (Phase 0): read-only, governed.
 *
 * GET → {
 *   suggestions: SuggestedCheck[]  — deterministic profile→rule proposals, each citing
 *                                    its profile evidence (0 nulls ⇒ not_null, 100%
 *                                    distinct ⇒ unique, small category set ⇒
 *                                    accepted_values, numeric min/max ⇒ range). Empty
 *                                    when nothing is materialised (honest, never faked).
 *   trend: {ranAt,score,badge}[]   — the persisted health-score time-series (sparkline).
 *   latest: {...} | null           — the most recent persisted run for this dataset.
 * }
 *
 * The profile is generated + run through the SAME governed `queryRun` the profile route
 * uses, so the caller's principal reaches Trino's OPA plugin — a non-viewer is refused by
 * the registry (403) before any SQL, and column masks are preserved. Anonymous ⇒ 401.
 * Suggestions are computed but NOT written — the client accepts them through the normal
 * governed `POST /checks` path (the same gate the manual editor uses).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal(); // 401 for anon
    const { id } = await ctx.params;
    const dataset = getDataset(id, user); // 403 for a non-viewer (canView guard)

    // The durable trend + latest run (best-effort — a mirror miss degrades to empty).
    let trend: ReturnType<typeof healthTrend> = [];
    let latest: ReturnType<typeof latestRun> = null;
    try {
      await ensureHydrated();
      trend = healthTrend(id);
      latest = latestRun(id);
    } catch { /* durable history is additive — suggestions still return */ }

    // Suggestions need a materialised layer to profile. No layer ⇒ honest empty.
    const resolved = builtLayerFqn(dataset, user);
    if (!resolved) {
      return NextResponse.json({ suggestions: [], trend, latest, profiled: false });
    }

    let profile: Profile | null = null;
    try {
      const describe = await queryRun(`describe ${resolved.fqn}`, resolved.principal);
      const columns: ProfileColumn[] = parseDescribe(describe);
      const statsRes = await queryRun(statsSql(resolved.fqn, columns), resolved.principal);
      const previewRes = await queryRun(previewSql(resolved.fqn, 50), resolved.principal);
      let topRes = null;
      if (columns.length > 0 && columns.length <= MAX_TOPVALUE_COLUMNS) {
        const sql = topValuesSql(resolved.fqn, columns, 5);
        if (sql) {
          try { topRes = await queryRun(sql, resolved.principal); } catch { topRes = null; }
        }
      }
      profile = assembleProfile({ fqn: resolved.fqn, layer: resolved.layer, columns, statsRes, topRes, previewRes });
    } catch {
      // The layer isn't queryable yet — answer calmly with no suggestions, not a 5xx.
      return NextResponse.json({ suggestions: [], trend, latest, profiled: false });
    }

    const suggestions = suggestChecks(profile, dataset.checks ?? []);
    return NextResponse.json({ suggestions, trend, latest, profiled: true });
  } catch (e) {
    return errorResponse(e);
  }
}
