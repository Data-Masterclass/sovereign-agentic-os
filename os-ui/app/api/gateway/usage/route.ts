/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { withRoute } from '@/lib/core/route-server';
import { tenantRuns } from '@/lib/monitoring/adapters/agent-telemetry';
import {
  shapeActivity,
  weeklyRunSpend,
  type GatewayUsage,
  type RawActivity,
} from '@/lib/monitoring/gateway-usage';

export const dynamic = 'force-dynamic';

/**
 * LLM Gateway usage (read-only, ALL users). Two honest sources, shaped server-side:
 *   • requests + tokens: LiteLLM `/global/activity` (the master key NEVER leaves
 *     this process) — LiteLLM meters these regardless of pricing. `activity: null`
 *     when the gateway did not answer (the tab renders "—", not a fake 0).
 *   • spend (7 days, EUR): the OS's own run-summary traces via `tenantRuns` — the
 *     SAME sources and run-time EUR pricing the Monitoring tiles use, so the two
 *     tabs agree. NOT LiteLLM `/global/spend`, which meters $0 forever for
 *     self-hosted routes absent from LiteLLM's price map.
 * No per-user data, no keys — the browser sees only the shaped `usage` object.
 * Requires an OS session (401 for anon).
 */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${config.litellmUrl}${path}`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const GET = withRoute(async () => {
  // Tenant activity totals — fail soft to null. `/global/activity` REQUIRES a
  // start_date/end_date (a bare call 400s) — pass a rolling 30-day window
  // (YYYY-MM-DD, UTC).
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const nowMs = Date.now();
  const end = new Date(nowMs);
  const start = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const activity = await getJson<RawActivity>(
    `/global/activity?start_date=${iso(start)}&end_date=${iso(end)}`,
  );

  // 7-day tenant spend from the run-summary traces (Langfuse + in-process ring).
  const { runs, langfuseReachable } = await tenantRuns(nowMs);
  const weekly = weeklyRunSpend(runs, nowMs);
  // With Langfuse down, ring runs still prove telemetry; down + empty ⇒ unknown.
  const telemetryOk = langfuseReachable || runs.length > 0;

  const usage: GatewayUsage = {
    activity: activity == null ? null : shapeActivity(activity),
    weekly: { ...weekly, telemetryOk },
    budgetUsd: config.litellmBudgetUsd,
    budgetWindow: config.litellmBudgetWindow,
  };
  return NextResponse.json({ usage });
});
