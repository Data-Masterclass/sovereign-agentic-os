/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse enrichment for one run's diagnostics table — read BY THE RUN'S TRACE ID.
 * USER STORY: As a builder I see tokens, latency and cost per agent for the run I just made, and only
 *             for that run: no diagnostics read can ever return another user's observations.
 * ARCHITECTURE:
 *   - Session-gated (`withRoute`) and run-scoped. `?runId=` → observations of trace id = run id (the
 *     A3 trace); without a run id (walker runs have none) the read is bounded to the CALLER's own
 *     traces since the run started (`userId` + `fromTimestamp`). `observationsQuery` refuses anything
 *     looser with a typed error — the A2 leak (an unfiltered `?limit=100` read) cannot recur.
 *   - The table itself renders from the run's own step data; this route only adds trace metrics and
 *     returns `{ available: false }` (never an error to the user) when the store is unreachable.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { readObservations, UnfilteredLangfuseQueryError } from '@core/infra/langfuse';
import { isRunId } from '@core/kernel/run-id';
import { shapeTraceMetrics, type RawObservation, type TraceMetrics } from '@tabs/agents/lib/build/run-diagnostics';

export const dynamic = 'force-dynamic';

const UNAVAILABLE: TraceMetrics = { available: false, perNode: {}, totals: { tokens: 0, latencyMs: 0, costUsd: 0 } };

/** Without a run id, look back at most this far for the caller's own observations. */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

export const GET = withRoute<{ id: string }>(async ({ req, user }) => {
  const url = new URL(req.url);
  // The client passes the run's node names so observations can be attributed to a
  // node; missing/garbage input just yields un-attributed (totals-only) metrics.
  const nodeNames = (url.searchParams.get('nodes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const runId = (url.searchParams.get('runId') ?? '').trim();
  if (runId && !isRunId(runId)) return NextResponse.json({ error: 'runId is not a run id' }, { status: 400 });
  const since = Number(url.searchParams.get('since') ?? '');
  const fromTimestamp = new Date(Number.isFinite(since) && since > 0 ? Math.max(since, Date.now() - LOOKBACK_MS) : Date.now() - LOOKBACK_MS).toISOString();

  let observations;
  try {
    observations = await readObservations(
      runId ? { traceId: runId, type: 'GENERATION' } : { userId: user.id, fromTimestamp, type: 'GENERATION' },
    );
  } catch (e) {
    if (e instanceof UnfilteredLangfuseQueryError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (observations === null) {
    // Trace store is down — honest, never a broken table.
    return NextResponse.json({ metrics: UNAVAILABLE });
  }
  return NextResponse.json({ metrics: shapeTraceMetrics(observations as RawObservation[], nodeNames) });
});
