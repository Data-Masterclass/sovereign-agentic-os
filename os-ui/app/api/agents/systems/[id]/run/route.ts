/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run one agent system (start or resume) through the governed engine, streaming progress.
 * USER STORY: As a builder I press Run and watch each agent work, every tool call governed as me; a
 *             run interrupted by a restart resumes from its checkpoint instead of starting over.
 * ARCHITECTURE: ENQUEUE + TAIL (A4). The route validates, mints the
 *             run id, files a `run_jobs` row and then TAILS that run's `run_events` — it never
 *             drives the graph itself. A RESUME is owner-gated HERE, before the enqueue
 *             (`assertRunVisible`, A4-review-H-1): the engine's own gate fires only after the row
 *             has been re-queued and the history has streamed, which let a guessed run id replay
 *             somebody else's run. `AGENTS_WORKER=inline` (the default) executes the job in
 *             this process right after filing it, so the response, the events and the error
 *             statuses are identical to before; `worker` leaves it to the `os-ui-worker` pod, so a
 *             run outlives the request. Since A5 there is NO other engine and no request-bound
 *             path: every run of every system goes through the queue.
 *             Thin route over `tabs/agents/lib/build/run-jobs-server.ts` + `engine/jobs.ts`.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getSystemForRun, setRunning, clearActivity } from '@tabs/agents/lib/store';
import { newRunId } from '@core/kernel/run-id';
import { enqueueRun, runJobStore } from '@tabs/agents/lib/build/run-jobs-server';
import { isTerminalEvent, tailRunEvents, type RunEventRow } from '@tabs/agents/lib/engine/jobs';
import { assertRunVisible } from '@tabs/agents/lib/engine/run-visibility';
import { acquireTail } from '@tabs/agents/lib/engine/tail-limit';
import { unmappedGrantNames } from '@tabs/agents/lib/build/os-tools';
import { cleanTurns } from '@core/runtime/turns';

export const dynamic = 'force-dynamic';
// A multi-node team walk (each node a PLAN→ACT loop on a large model) can run long;
// give the streamed turn room before the platform kills it (mirrors the software team).
export const maxDuration = 300;
/** How long the route follows a queued run before handing the client a 202 + the run id to re-attach. */
const TAIL_BUDGET_MS = 240_000;

type ChatMsg = { role: 'user' | 'assistant'; content: string };

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  const retryAfter = (e as { retryAfterSeconds?: number })?.retryAfterSeconds;
  return NextResponse.json(
    { error: (e as Error).message },
    { status, ...(retryAfter ? { headers: { 'retry-after': String(retryAfter) } } : {}) },
  );
}

/**
 * A sensible DEFAULT run task when the caller supplies no prompt — derived from the
 * system's own purpose (name + domain) so the team does its real job, NOT the literal
 * "Test invocation" that made recommenders no-op ("No action needed — this is a test").
 * The build/verify probe keeps its own "Test invocation" string; this is the RUN path.
 */
function defaultRunTask(system: { system: { name: string; domain: string } }): string {
  const name = system.system.name?.trim() || 'this team';
  const domain = system.system.domain?.trim();
  const scope = domain ? ` over the ${domain} domain` : '';
  return (
    `Do your standard job as the ${name}${scope}: assess the current state, ` +
    `then produce your concrete recommended actions with the reasons behind them.`
  );
}

/** A turn's conversation from the request body (`messages`, else `prompt`). */
function runMessages(body: Record<string, unknown>, prompt: string): ChatMsg[] {
  const clean = cleanTurns(body.messages);
  return clean.length > 0 ? clean : [{ role: 'user', content: prompt }];
}

/** The client opts into live SSE progress by asking for `text/event-stream`. */
function wantsStream(req: Request, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  return (req.headers.get('accept') ?? '').includes('text/event-stream');
}

/**
 * POST → run a test invocation of the system through the governed gateway (every
 * tool call OPA-checked + Langfuse-traced), and flip the running flag. `stop:true`
 * just halts the system without an invocation. `{ resume: true, runId }` continues a
 * LangGraph thread (restart recovery); a run PARKED on an approval is resumed by the
 * Governance decision itself (A2) — the panel re-attaches to `GET …/run/stream?runId=`.
 *
 * SSE events: `node-started`, `tool-step`, `node-completed` (unchanged), `approval-required`
 * `{ approvalId, tool, node }` when a held write parks the run, `resumed` `{ approvalId,
 * decision }` on the re-attach stream when a decision continues it, then `done` (whose body
 * carries `parked` + `heldApprovals` for a parked run) or `error`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let resolvedId: string | undefined;
  let resolvedUser: Awaited<ReturnType<typeof requireUser>> | undefined;
  // When we hand the run off to an SSE stream, the stream owns activity-cleanup
  // (it runs after this function returns); the outer finally must NOT clear early.
  let streamed = false;
  try {
    resolvedUser = await requireUser();
    const { id } = await ctx.params;
    resolvedId = id;
    const body = await req.json().catch(() => ({}));

    if (body.stop === true) {
      const rec = setRunning(id, resolvedUser, false);
      return NextResponse.json({ running: rec.running });
    }

    // Run-scope authorization BEFORE any side effect: an owner/in-domain admin, OR
    // a Creator+ consuming a domain-Shared system (the governed "run the ready-made
    // agent" path). A mere viewer / out-of-domain / participant is rejected here.
    const view = getSystemForRun(id, resolvedUser);
    // PRE-FLIGHT (A5): every system runs on the ONE engine, so the only thing that can make a
    // system un-runnable is a grant naming a tool with no governed MCP tool behind it. Say which,
    // here, as a 400 — instead of letting `buildGraph` throw the same fact from inside a worker.
    const unmapped = unmappedGrantNames(view.system);
    if (unmapped.length > 0) {
      return NextResponse.json(
        { error: `This system grants tool(s) with no governed MCP tool behind them: ${unmapped.join(', ')}. Fix the grants in system.yaml, then run again.` },
        { status: 400 },
      );
    }
    // RUN path: an empty prompt falls back to a real, purpose-derived task — never the
    // literal "Test invocation" that made recommenders answer "no action needed".
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : defaultRunTask(view.system);

    // RESUME (engine rebuild A1): `{ resume: true, runId }` continues an interrupted LangGraph
    // thread from its last checkpoint.
    const resume = body.resume === true;
    const requestedRunId = typeof body.runId === 'string' ? body.runId.trim() : '';
    if (resume && !requestedRunId) return NextResponse.json({ error: 'resume needs the runId of the interrupted run' }, { status: 400 });
    // Thread id = run id: minted here, carried on the run report and LastRun, continued by Resume.
    const runId = resume ? requestedRunId : newRunId();

    // The governed yaml is prepared by the EXECUTOR as the live runner (`prepareRunYaml` inside
    // `executeJob`), not here: a queued run must not be governed twice, and the route no longer
    // has a request-bound path that would need it.
    const messages = runMessages(body, prompt);
    const user = resolvedUser;

    // ---- A4: the governed engine runs through the QUEUE, never in this request ----------
    const store = await runJobStore();
    // OWNER GATE FIRST (A4-review-H-1). A resume names an EXISTING run, so before anything is
    // enqueued or streamed the row must be this caller's and this system's — otherwise 404,
    // the same answer an unknown id gets. Without this, `enqueueRun` re-queued the foreign row
    // (overwriting `requested_by`) and the tail replayed its whole history from seq 0 before
    // the engine's own owner check refused it.
    if (resume) assertRunVisible(await store.get(runId), runId, user.id, id);
    // File the job. A start that collides with an existing run id, or a resume of a run that
    // is already queued/running, is a typed 409; a resume of an unknown run is a typed 404 —
    // both thrown BEFORE anything looks like a run.
    const queued = await enqueueRun({
      runId,
      systemId: id,
      domain: view.system.system.domain,
      requestedBy: user.id,
      user,
      kind: resume ? 'resume' : 'start',
      input: { messages, prompt: resume ? undefined : prompt },
    });

    // STREAMING path: tail `run_events` from seq 0 — the same ordered vocabulary
    // (`node-started`, `tool-step`, `node-completed`, `approval-required`, `resumed`, then
    // `done` / `error`) the panel already understands, now replayable and re-attachable from
    // any pod. A run that parks on an approval ends this stream with a `done{parked}`; the
    // panel re-attaches to GET …/run/stream?runId= to see the decision continue it.
    if (wantsStream(req, body)) {
      // One tail slot per open stream (L-6): a pod refuses the 65th honestly instead of
      // starving its connection pool. Released on close OR on client disconnect.
      const releaseTail = acquireTail();
      streamed = true;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          try {
            const out = await tailRunEvents(store, runId, { until: 'settled', afterSeq: 0, signal: req.signal, timeoutMs: TAIL_BUDGET_MS }, (ev) => send(ev.event, ev.data));
            if (out.ended === 'timeout') send('queued', { runId, afterSeq: out.lastSeq, note: 'still running — re-attach to /run/stream' });
          } catch (e) {
            send('error', { error: (e as Error).message });
          } finally {
            releaseTail();
            controller.close();
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

    // NON-STREAMING: inline mode awaits its own execution, so a refused run keeps the exact
    // status it had before A4; worker mode follows the event log until the job settles.
    if (queued.inflight) await queued.inflight;
    const seen: RunEventRow[] = [];
    const releaseTail = acquireTail();
    let out;
    try {
      out = await tailRunEvents(store, runId, { until: 'settled', afterSeq: 0, signal: req.signal, timeoutMs: TAIL_BUDGET_MS }, (ev) => { seen.push(ev); });
    } finally {
      releaseTail();
    }
    const terminal = seen.filter(isTerminalEvent).at(-1) ?? seen.filter((e) => e.event === 'done').at(-1);
    if (!terminal) {
      return NextResponse.json({ queued: true, runId, engine: 'langgraph', mode: queued.mode, afterSeq: out.lastSeq, note: 'the run is still executing — tail /run/stream?runId=' }, { status: 202 });
    }
    if (terminal.event === 'error') {
      const d = (terminal.data ?? {}) as { error?: string; status?: number };
      return NextResponse.json({ error: d.error ?? 'the run failed', runId }, { status: d.status ?? 500 });
    }
    return NextResponse.json(terminal.data);
  } catch (e) {
    return fail(e);
  } finally {
    // The streaming path clears activity from inside the stream (after this returns).
    if (resolvedId && !streamed) clearActivity(resolvedId);
  }
}
