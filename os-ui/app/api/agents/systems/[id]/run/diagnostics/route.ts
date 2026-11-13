/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse enrichment for one run's diagnostics table — read BY THE RUN'S TRACE ID.
 * USER STORY: As a builder I see tokens, latency and cost per agent for the run I just made, and only
 *             for that run: no diagnostics read can ever return another user's observations.
 * ARCHITECTURE:
 *   - Session-gated (`withRoute`) and run-scoped. `?runId=` → observations of trace id = run id (the
 *     A3 trace), but ONLY after `assertRunVisible` says that run is this caller's and this system's:
 *     a run id is not an authorisation (A4-review-H-1), and a trace id IS a run id, so reading by
 *     trace id without the owner gate let a guessed id return somebody else's generations. A
 *     foreign or unknown run answers 404, the same way.
 *   - Without a run id — only a run recorded before the rebuild has none — the read is bounded to
 *     the CALLER's own traces since the run started (`userId` + `fromTimestamp`).
 *     `observationsQuery` refuses anything looser with a typed error, so the A2 leak (an
 *     unfiltered `?limit=100` read) cannot recur.
 *   - The table itself renders from the run's own step data; this route only adds trace metrics and
 *     returns `{ available: false }` (never an error to the user) when the store is unreachable.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { readObservations, UnfilteredLangfuseQueryError } from '@core/infra/langfuse';
import { isRunId } from '@core/kernel/run-id';
import { assertRunVisible } from '@tabs/agents/lib/engine/run-visibility';
import { runJobStore } from '@tabs/agents/lib/build/run-jobs-server';
import { shapeTraceMetrics, type RawObservation, type TraceMetrics } from '@tabs/agents/lib/build/run-diagnostics';

export const dynamic = 'force-dynamic';

const UNAVAILABLE: TraceMetrics = { available: false, perNode: {}, totals: { tokens: 0, latencyMs: 0, costUsd: 0 } };

/** Without a run id, look back at most this far for the caller's own observations. */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

export const GET = withRoute<{ id: string }>(async ({ req, user, params }) => {
  const url = new URL(req.url);
  // The client passes the run's node names so observations can be attributed to a
  // node; missing/garbage input just yields un-attributed (totals-only) metrics.
  const nodeNames = (url.searchParams.get('nodes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const runId = (url.searchParams.get('runId') ?? '').trim();
  if (runId && !isRunId(runId)) return NextResponse.json({ error: 'runId is not a run id' }, { status: 400 });
  // OWNER GATE before any trace read (A5, closing the same hole A4-review-H-1 closed on the run
  // route): the trace id IS the run id, so a caller may only read the trace of a run that is
  // theirs, on this system. Unknown and foreign are the same answer — 404.
  if (runId) {
    try {
      assertRunVisible(await (await runJobStore()).get(runId), runId, user.id, params.id);
    } catch (e) {
      const status = (e as { status?: number })?.status ?? 404;
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
  }
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
