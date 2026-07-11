/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystemForRun, setRunning, recordActivity, setActivity, clearActivity, setLastRun } from '@/lib/agents/store';
import type { LastRun } from '@/lib/agents/store';
import { runSystem } from '@/lib/agents/build/server';
import { runOsTeam } from '@/lib/agents/build/agentic-graph-server';
import { isAgenticOsTeam } from '@/lib/agents/build/os-tools';
import { classifyStepError, type AgenticGraphResult } from '@/lib/agents/build/agentic-graph';
import { governYamlForOwner } from '@/lib/agents/build/owner-grants';

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

/** A one-line, single-line result summary for a tool step (observability, kept tight). */
function summarizeResult(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Bound a full step field (tool args JSON / raw result) for the drill-down. */
function boundField(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/** The per-node reveal shape returned to the UI (and persisted into LastRun). */
function nodeReveal(r: {
  node: string;
  model: string;
  tier?: 'fast' | 'reasoning';
  tierReason?: string;
  status: string;
  error?: string;
  input?: string;
  result: { finalText: string; steps: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }[] };
}) {
  return {
    node: r.node,
    model: r.model,
    // AUTO per-node routing decision: which tier, and the deterministic reason —
    // so the drill-down shows "performance_analyst → fast · read-only gatherer".
    tier: r.tier,
    tierReason: r.tierReason,
    status: r.status,
    error: r.error,
    // What this agent was GIVEN (role prompt + team-progress handoff + user turn).
    input: r.input ? boundField(r.input, 8_000) : undefined,
    finalText: r.result.finalText,
    steps: r.result.steps.map((s) => ({
      tool: s.tool,
      isError: s.isError,
      // Errored steps carry WHY: a real governance block ('policy') vs an execution
      // failure ('exec'), so the UI shows "DENIED" only for the former.
      errorKind: s.isError ? classifyStepError(s.result) : undefined,
      summary: summarizeResult(s.result),
      // Full INPUT (args) and OUTPUT (result) so a step can be inspected, not just named.
      args: boundField(JSON.stringify(s.args ?? {})),
      result: boundField(s.result),
    })),
  };
}

/**
 * Finalize a completed team run into (a) the exact JSON body the non-streaming path
 * has always returned AND (b) the `LastRun` record persisted so the 0.1.80 legible
 * render + per-node persistence keep working. Kept as ONE function so the streaming
 * `done` frame and the non-streaming JSON response are byte-for-byte the same shape.
 */
function finalizeTeamRun(team: AgenticGraphResult, running: boolean) {
  // Normalise team run into LastRun shape and persist it.
  const teamSteps = team.runs.flatMap((r) =>
    r.result.steps.map((s) => ({
      node: r.node,
      // A real policy block → 'deny'; an execution failure → 'error'; else 'allow'.
      effect: !s.isError ? 'allow' : classifyStepError(s.result) === 'policy' ? 'deny' : 'error',
      tool: s.tool,
      ran: true,
    })),
  );
  // A run is ok iff no node failed or had a denied/errored tool.
  const teamOk = team.runs.every((r) => r.status === 'ok');
  // Per-node drill-down: model + STATUS + what that agent was GIVEN (input) + what
  // it concluded (finalText) + its tool calls with args → result. Built once, and
  // PERSISTED into LastRun so the per-agent cards survive a tab-switch / reseed.
  const nodes = team.runs.map(nodeReveal);
  const lastRun: LastRun = {
    at: Date.now(),
    running,
    ok: teamOk,
    path: team.path,
    traces: 0,
    held: 0,
    steps: teamSteps,
    nodes,
    output: team.finalText,
    mode: 'live',
  };
  const body = { running, mode: 'live' as const, team: true, ok: teamOk, path: team.path, finalText: team.finalText, nodes };
  return { body, lastRun };
}

/** A turn's conversation from the request body (`messages`, else `prompt`). */
function runMessages(body: Record<string, unknown>, prompt: string): ChatMsg[] {
  const raw = Array.isArray(body.messages) ? (body.messages as ChatMsg[]) : [];
  const clean = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  return clean.length > 0 ? clean : [{ role: 'user', content: prompt }];
}

/** Flip the persistent running flag for editors; record activity for run-only. */
function markRun(id: string, user: Parameters<typeof setRunning>[1]): boolean {
  try {
    return setRunning(id, user, true).running;
  } catch {
    recordActivity(id);
    return false;
  }
}

/**
 * POST → run a test invocation of the system through the governed gateway (every
 * tool call OPA-checked + Langfuse-traced), and flip the running flag. `stop:true`
 * just halts the system without an invocation.
 */
/** The client opts into live SSE progress by asking for `text/event-stream`. */
function wantsStream(req: Request, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  return (req.headers.get('accept') ?? '').includes('text/event-stream');
}

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
    // RUN path: an empty prompt falls back to a real, purpose-derived task — never the
    // literal "Test invocation" that made recommenders answer "no action needed".
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : defaultRunTask(view.system);

    // Mark in-progress so a returning user sees "running since…" not a blank slate.
    setActivity(id, { kind: 'running', startedAt: Date.now() });

    // Re-assert the builder-gate against the OWNER's CURRENT role (S1): a stale
    // direct-write grant (set while the owner was a builder, or by an admin) is
    // downgraded to held-for-approval before this run — read live, never trusted
    // from the saved yaml.
    const yaml = await governYamlForOwner(view.yaml, view.owner);

    // Any agentic-os LangGraph team (data + knowledge + connections + software
    // grants, all resolving to the MCP registry) runs LIVE, in-process, as the
    // signed-in user: each node runs the PLAN→ACT harness with its pinned model and
    // executes tools via grantedToolExecutor → handleRpc(user, …) — governed as the
    // acting user, never a system principal. Hermes/unmapped-legacy systems keep the
    // runtime/mock `runSystem` fallback path.
    if (isAgenticOsTeam(view.system)) {
      const messages = runMessages(body, prompt);
      const user = resolvedUser;

      // Complete a finished team result: flip the running flag, persist LastRun, and
      // return the exact JSON body (shared by the stream's `done` frame and the
      // non-streaming response, so the final render is identical either way).
      const complete = (team: AgenticGraphResult) => {
        const running = markRun(id, user);
        const { body: out, lastRun } = finalizeTeamRun(team, running);
        try { setLastRun(id, user, lastRun); } catch { /* run-only consumer: persist best-effort */ }
        return out;
      };

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
              const team = await runOsTeam({
                user,
                yaml,
                systemId: id,
                messages,
                disabledAgents: view.disabledAgents,
                onNodeStart: (ev) => send('node-started', ev),
                onStep: (ev) =>
                  send('tool-step', {
                    node: ev.node,
                    tool: ev.step.tool,
                    // Match the persisted per-step semantics: a policy block reads
                    // 'denied', any other tool error 'error', else 'ok'.
                    status: !ev.step.isError
                      ? 'ok'
                      : classifyStepError(ev.step.result) === 'policy'
                        ? 'denied'
                        : 'error',
                    index: ev.index,
                  }),
                onNodeComplete: (ev) =>
                  send('node-completed', { node: ev.node, status: ev.status, finalTextPreview: summarizeResult(ev.finalText) }),
              });
              send('done', complete(team));
            } catch (e) {
              send('error', { error: (e as Error).message });
            } finally {
              clearActivity(id);
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
      const team = await runOsTeam({ user, yaml, systemId: id, messages, disabledAgents: view.disabledAgents });
      return NextResponse.json(complete(team));
    }

    const report = await runSystem(id, yaml, {
      prompt,
      requestedBy: resolvedUser.id,
      disabledAgents: view.disabledAgents,
    });
    // Flip the PERSISTENT running flag only for editors (owner / in-domain admin);
    // a run-scoped consumer performs a transient invocation and must NOT mutate the
    // shared record's state — record activity instead.
    const running = markRun(id, resolvedUser);
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
    return NextResponse.json({ running, ...report });
  } catch (e) {
    return fail(e);
  } finally {
    // The streaming path clears activity from inside the stream (after this returns).
    if (resolvedId && !streamed) clearActivity(resolvedId);
  }
}
