/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset, builtLayerFqn, setMonitor } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import { ensureHydrated, healthTrend, latestRun } from '@/lib/data/dq-results';
import { suggestChecks } from '@/lib/data/dq-suggest';
import { MONITOR_KINDS, monitorEnabled, type MonitorConfig, type MonitorKind } from '@/lib/data/dq-monitors';
import { isNotMaterialized } from '@/lib/data/materialized';
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
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user); // 403 for a non-viewer (canView guard)

  // The durable trend + latest run (best-effort — a mirror miss degrades to empty).
  let trend: ReturnType<typeof healthTrend> = [];
  let latest: ReturnType<typeof latestRun> = null;
  try {
    await ensureHydrated();
    trend = healthTrend(id);
    latest = latestRun(id);
  } catch { /* durable history is additive — suggestions still return */ }

  // The default-ON monitor toggles (freshness/volume/schema), reflecting stored config.
  const monitors = MONITOR_KINDS.map((kind) => ({
    kind,
    enabled: monitorEnabled(dataset.monitors as MonitorConfig | undefined, kind),
  }));

  // Suggestions need a materialised, queryable layer to profile. When there's nothing to
  // profile we still answer 200 with `profiled: false` — but ALSO carry a machine-readable
  // `reason` so the Validate UI can show ONE honest line instead of a blank void (the empty
  // state that made curated datasets look "silently broken": their single composed Gold is
  // the ONLY layer — no bronze/silver fallback — so before that build lands there is no
  // table to profile, and the bare catch used to swallow the WHY).
  const resolved = builtLayerFqn(dataset, user);
  if (!resolved) {
    return NextResponse.json({ suggestions: [], trend, latest, monitors, profiled: false, reason: 'no built layer' });
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
  } catch (e) {
    // The layer's table isn't materialised/queryable yet — answer calmly with no
    // suggestions (never a 5xx), but distinguish "registered, not built yet" from a real
    // engine fault so the UI can say the right honest thing.
    const reason = isNotMaterialized(e) ? 'layer not queryable' : 'profile failed';
    return NextResponse.json({ suggestions: [], trend, latest, monitors, profiled: false, reason });
  }

  const suggestions = suggestChecks(profile, dataset.checks ?? []);
  return NextResponse.json({ suggestions, trend, latest, monitors, profiled: true });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * POST → toggle a heuristic monitor (freshness/volume/schema) for this dataset. Governed
 * by the canEdit gate (`setMonitor` → `editOf`): a viewer is refused. Default-ON — turning
 * one back on drops it from the stored config so an all-on dataset stays byte-stable.
 */
export const POST = withRoute<{ id: string }, { kind?: string; enabled?: boolean }>(async ({ user, params, body }) => {
  const { id } = params;
  const kind = body.kind as MonitorKind;
  if (!MONITOR_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'unknown monitor' }, { status: 400 });
  }
  const dataset = setMonitor(id, user, kind, body.enabled !== false); // canEdit gate (403)
  const monitors = MONITOR_KINDS.map((k) => ({
    kind: k,
    enabled: monitorEnabled(dataset.monitors as MonitorConfig | undefined, k),
  }));
  return NextResponse.json({ monitors });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
