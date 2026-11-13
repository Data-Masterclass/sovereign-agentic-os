/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tail a run's durable event log — watch a parked or worker-executed run from any pod.
 * USER STORY: As the runner I keep the Run panel open while a domain admin decides, or while the
 *             worker executes a run far longer than my request could live; when the run continues
 *             — in another request, in another pod, after a restart — my panel sees `resumed` →
 *             `node-started` … `done` exactly as if I had never left, and a reconnect replays only
 *             what I missed.
 * ARCHITECTURE: GET ?runId=[&afterSeq=] tails `run_events` through `engine/jobs.ts` `tailRunEvents`
 *             (A4; replaces the in-process topic of A2). Owner-checked against the `run_jobs` row
 *             through the SHARED `assertRunVisible` (system + runner, A4-review-H-1) AND the
 *             caller's run scope — anything else is 404, never confirming the run exists.
 *             `afterSeq` is the client's cursor: 0 replays the whole run. One tail slot per open
 *             stream, so a pod refuses the 65th with 503 + `Retry-After` instead of starving its
 *             connection pool (A4-review-L-6).
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { isRunId } from '@core/kernel/run-id';
import { getSystemForRun } from '@tabs/agents/lib/store';
import { runJobStore } from '@tabs/agents/lib/build/run-jobs-server';
import { tailRunEvents } from '@tabs/agents/lib/engine/jobs';
import { assertRunVisible } from '@tabs/agents/lib/engine/run-visibility';
import { acquireTail } from '@tabs/agents/lib/engine/tail-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
/** Hand the client a cursor rather than holding the connection past the platform's cap. */
const TAIL_BUDGET_MS = 240_000;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const runId = url.searchParams.get('runId') ?? '';
  if (!isRunId(runId)) return NextResponse.json({ error: 'runId required' }, { status: 400 });
  const afterSeq = Math.max(0, Number(url.searchParams.get('afterSeq') ?? '0') || 0);
  try {
    getSystemForRun(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 403 });
  }
  const store = await runJobStore();
  try {
    assertRunVisible(await store.get(runId), runId, user.id, id);
  } catch (e) {
    return NextResponse.json({ error: 'No run stream for this run' }, { status: (e as { status?: number }).status ?? 404 });
  }

  let releaseTail: () => void;
  try {
    releaseTail = acquireTail();
  } catch (e) {
    const retry = (e as { retryAfterSeconds?: number }).retryAfterSeconds ?? 5;
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { 'retry-after': String(retry) } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };
      try {
        const out = await tailRunEvents(store, runId, { until: 'terminal', afterSeq, signal: req.signal, timeoutMs: TAIL_BUDGET_MS }, (ev) => send(ev.event, ev.data));
        if (out.ended === 'timeout') send('queued', { runId, afterSeq: out.lastSeq, note: 'still running — re-attach with afterSeq' });
      } catch (e) {
        send('error', { error: (e as Error).message });
      } finally {
        closed = true;
        releaseTail();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { releaseTail(); },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}
