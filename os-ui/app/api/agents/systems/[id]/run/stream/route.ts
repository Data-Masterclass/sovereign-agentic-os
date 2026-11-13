/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Re-attach to a run's live event stream (A2) — watch a parked run finish after a decision.
 * USER STORY: As the runner I keep the Run panel open while a domain admin decides; when the decision
 *             resumes my run in another request, my panel sees `resumed` → `node-started` … `done`.
 * ARCHITECTURE: GET ?runId= over the in-process run topic (`engine/run-events.ts`); owner-checked
 *             (system + runner) — anything else is 404, never confirming the run exists. Single
 *             replica until A4 moves the topic to `run_events`.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { isRunId } from '@core/kernel/run-id';
import { getSystemForRun } from '@tabs/agents/lib/store';
import { runTopicOwner, subscribeRun } from '@tabs/agents/lib/engine/run-events';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET ?runId= → re-attach to the live event stream of a run (A2). A run PARKED on an approval
 * is resumed by the Governance decision in ANOTHER request; the panel attaches here to watch it
 * finish. Replays what it missed, then streams until a terminal `done` (non-parked) / `error`.
 * Only the run's own system + runner may attach — anything else is 404 (never confirming the
 * run exists). Single-replica: the topic lives in this process (A4 moves it to `run_events`).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;
  const runId = new URL(req.url).searchParams.get('runId') ?? '';
  if (!isRunId(runId)) return NextResponse.json({ error: 'runId required' }, { status: 400 });
  try {
    getSystemForRun(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 403 });
  }
  const owner = runTopicOwner(runId);
  if (!owner || owner.systemId !== id || owner.userId !== user.id) {
    return NextResponse.json({ error: 'No live stream for this run' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      unsubscribe = subscribeRun(
        runId,
        (ev) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
        },
        close,
      );
      req.signal.addEventListener('abort', close);
    },
    cancel() {
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}
