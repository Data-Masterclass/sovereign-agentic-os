/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run one agent system (start or resume) through the governed engine, streaming progress.
 * USER STORY: As a builder I press Run and watch each agent work, every tool call governed as me; a
 *             run interrupted by a restart resumes from its checkpoint instead of starting over.
 * ARCHITECTURE: thin route over `tabs/agents/lib/build/run-service.ts` (`prepareRunYaml`,
 *             `executeTeamRun`); engine chosen by `selectEngine`; SSE or JSON; thread id = run id.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getSystemForRun, setRunning, recordActivity, clearActivity, setActivity, setLastRun, startRunCheckpoint } from '@tabs/agents/lib/store';
import type { LastRun } from '@tabs/agents/lib/store';
import { newRunId } from '@core/kernel/run-id';
import { runSystem } from '@tabs/agents/lib/build/server';
import { executeTeamRun, prepareRunYaml } from '@tabs/agents/lib/build/run-service';
import { isAgenticOsTeam } from '@tabs/agents/lib/build/os-tools';
import { cleanTurns } from '@core/runtime/turns';
import { config } from '@core/kernel/config';
import { selectEngine } from '@tabs/agents/lib/engine/select';

export const dynamic = 'force-dynamic';
// A multi-node team walk (each node a PLAN→ACT loop on a large model) can run long;
// give the streamed turn room before the platform kills it (mirrors the software team).
export const maxDuration = 300;

type ChatMsg = { role: 'user' | 'assistant'; content: string };

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
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

/**
 * Mark the run FINISHED: clear the persistent running flag for editors (the run has
 * completed by the time this is called), record activity for run-only consumers.
 */
function markRunFinished(id: string, user: Parameters<typeof setRunning>[1]): boolean {
  try {
    return setRunning(id, user, false).running;
  } catch {
    recordActivity(id);
    return false;
  }
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
    // ENGINE FLAG (engine rebuild, Phase A0): the platform default (AGENTS_ENGINE) and the
    // system's own `runtime` key decide which executor runs this turn. Only the walker is
    // implemented today; Phase A1 adds `if (engine === 'langgraph')` → buildGraph HERE, so
    // every other line of this route stays untouched.
    const engine = selectEngine(config, view.system);
    // RUN path: an empty prompt falls back to a real, purpose-derived task — never the
    // literal "Test invocation" that made recommenders answer "no action needed".
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : defaultRunTask(view.system);

    // RESUME (engine rebuild A1): `{ resume: true, runId }` continues an interrupted LangGraph
    // thread from its last checkpoint. Only the langgraph engine has threads to resume.
    const resume = body.resume === true;
    const requestedRunId = typeof body.runId === 'string' ? body.runId.trim() : '';
    if (resume && !requestedRunId) return NextResponse.json({ error: 'resume needs the runId of the interrupted run' }, { status: 400 });
    if (resume && engine !== 'langgraph') {
      return NextResponse.json({ error: 'resume is only available on the langgraph engine (AGENTS_ENGINE=langgraph); re-run instead' }, { status: 400 });
    }
    // Thread id = run id: minted here, carried on the run report and LastRun, continued by Resume.
    const runId = resume ? requestedRunId : newRunId();

    // The governed yaml this run executes: the OWNER's current role re-asserted over the grants
    // (a stale direct-write grant downgrades to held — S1) and folder grants late-bound to the
    // acting user's live DLS-scoped lists (Wave 3). Read live, never trusted from the saved yaml.
    const yaml = await prepareRunYaml(resolvedUser, view, id);

    // Any agentic-os LangGraph team (data + knowledge + connections + software
    // grants, all resolving to the MCP registry) runs LIVE, in-process, as the
    // signed-in user: each node runs the PLAN→ACT harness with its pinned model and
    // executes tools via grantedToolExecutor → handleRpc(user, …) — governed as the
    // acting user, never a system principal. Hermes/unmapped-legacy systems keep the
    // runtime/mock `runSystem` fallback path.
    if (isAgenticOsTeam(view.system)) {
      const messages = runMessages(body, prompt);
      const user = resolvedUser;
      const common = { user, systemId: id, view, yaml, messages, engine, runId, resume, prompt };

      // STREAMING path: the client asked for live progress (Accept: text/event-stream
      // or {stream:true}). Emit ordered node/step events as the walk happens, then a
      // terminal `done` carrying the SAME full result the non-stream path returns. On
      // any run error, emit `error` so the client falls back — never a stuck spinner.
      if (wantsStream(req, body)) {
        streamed = true;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            try {
              await executeTeamRun({ ...common, emit: send });
            } catch (e) {
              const err = e as Error & { status?: number };
              // A refused resume (404 unknown/foreign thread, 409 finished) never published `error`.
              if (err?.status === 404 || err?.status === 409) send('error', { error: err.message, status: err.status });
            } finally {
              controller.close();
            }
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

      // NON-STREAMING fallback: run to completion and return the final JSON as before.
      return NextResponse.json(await executeTeamRun(common));
    }

    if (resume) {
      return NextResponse.json({ error: 'This system does not run on the in-process engine (hermes runtime or unmapped legacy grants) — nothing to resume' }, { status: 400 });
    }
    // Legacy (hermes / unmapped-grant) path: mark in-progress + open the durable store checkpoint
    // exactly as before (the team path does this inside `executeTeamRun`).
    setActivity(id, { kind: 'running', startedAt: Date.now() });
    startRunCheckpoint(id, { prompt, plannedNodes: view.system.agents.map((a) => a.id) });
    const report = await runSystem(id, yaml, {
      prompt,
      requestedBy: resolvedUser.id,
      disabledAgents: view.disabledAgents,
    });
    // Flip the PERSISTENT running flag only for editors (owner / in-domain admin);
    // a run-scoped consumer performs a transient invocation and must NOT mutate the
    // shared record's state — record activity instead.
    const running = markRunFinished(id, resolvedUser);
    // Persist the run report so the panel can re-seed after a tab-switch.
    const lastRun: LastRun = {
      at: Date.now(),
      running,
      ok: report.ok ?? true,
      path: Array.isArray(report.path) ? report.path : [],
      traces: report.traces ?? 0,
      held: report.held ?? 0,
      steps: (report.steps ?? []).map((s: { node: string; tool: string; effect: string; ran?: boolean }) => ({
        node: s.node,
        tool: s.tool,
        effect: s.effect,
        ran: s.ran,
      })),
      output: report.output,
      mode: report.mode,
      traceStoreAvailable: report.traceStoreAvailable,
      traceUrl: report.traceUrl,
    };
    try { setLastRun(id, resolvedUser, lastRun); } catch { /* run-only consumer: persist best-effort */ }
    return NextResponse.json({ running, engine, ...report });
  } catch (e) {
    return fail(e);
  } finally {
    // The streaming path clears activity from inside the stream (after this returns).
    if (resolvedId && !streamed) clearActivity(resolvedId);
  }
}
