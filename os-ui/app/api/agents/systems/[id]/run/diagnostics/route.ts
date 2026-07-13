/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { requireUser } from '@/lib/core/auth';
import { errorResponse } from '@/lib/data/server';
import { shapeTraceMetrics, type RawObservation, type TraceMetrics } from '@/lib/agents/build/run-diagnostics';

export const dynamic = 'force-dynamic';

/**
 * Optional Langfuse ENRICHMENT for a completed run's diagnostics table
 * (session-gated, read-only). Reads the durable Langfuse trace store server-side
 * with the public API keys (which NEVER leave this process) and aggregates
 * per-node + total tokens/latency/cost. The table itself renders from the run's
 * own step data — this route only adds the trace metrics when the store is up,
 * and returns `{ available: false }` (never an error to the user) when it is not,
 * so the panel shows an honest "trace metrics unavailable" note.
 */
const UNAVAILABLE: TraceMetrics = { available: false, perNode: {}, totals: { tokens: 0, latencyMs: 0, costUsd: 0 } };

/** Read recent Langfuse observations, or null if the store is unreachable. */
async function fetchObservations(): Promise<RawObservation[] | null> {
  const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${config.langfuseUrl}/api/public/observations?limit=100&type=GENERATION`, {
      headers: { authorization: auth, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { data?: RawObservation[] } | null;
    return Array.isArray(body?.data) ? body!.data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  // Best-effort: the id is part of the route contract; consumed for parity/logging.
  await ctx.params;

  // The client passes the run's node names so observations can be attributed to a
  // node; missing/garbage input just yields un-attributed (totals-only) metrics.
  const nodeNames = (new URL(req.url).searchParams.get('nodes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const observations = await fetchObservations();
  if (observations === null) {
    // Trace store is down — honest, never a broken table.
    return NextResponse.json({ metrics: UNAVAILABLE });
  }
  return NextResponse.json({ metrics: shapeTraceMetrics(observations, nodeNames) });
}
