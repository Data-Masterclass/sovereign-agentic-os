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
import { governYamlForOwner } from '@/lib/agents/build/owner-grants';

export const dynamic = 'force-dynamic';

type ChatMsg = { role: 'user' | 'assistant'; content: string };

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
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
  status: string;
  error?: string;
  input?: string;
  result: { finalText: string; steps: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }[] };
}) {
  return {
    node: r.node,
    model: r.model,
    status: r.status,
    error: r.error,
    // What this agent was GIVEN (role prompt + team-progress handoff + user turn).
    input: r.input ? boundField(r.input, 8_000) : undefined,
    finalText: r.result.finalText,
    steps: r.result.steps.map((s) => ({
      tool: s.tool,
      isError: s.isError,
      summary: summarizeResult(s.result),
      // Full INPUT (args) and OUTPUT (result) so a step can be inspected, not just named.
      args: boundField(JSON.stringify(s.args ?? {})),
      result: boundField(s.result),
    })),
  };
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
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let resolvedId: string | undefined;
  let resolvedUser: Awaited<ReturnType<typeof requireUser>> | undefined;
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
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Test invocation';

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
      const team = await runOsTeam({
        user: resolvedUser,
        yaml,
        systemId: id,
        messages: runMessages(body, prompt),
        disabledAgents: view.disabledAgents,
      });
      const running = markRun(id, resolvedUser);
      // Normalise team run into LastRun shape and persist it.
      const teamSteps = team.runs.flatMap((r) =>
        r.result.steps.map((s) => ({ node: r.node, tool: s.tool, effect: s.isError ? 'deny' : 'allow', ran: true })),
      );
      // A run is ok iff no node failed or had a denied/errored tool.
      const teamOk = team.runs.every((r) => r.status === 'ok');
      // Per-node drill-down: model + STATUS + what that agent was GIVEN (input) + what
      // it concluded (finalText) + its tool calls with args → result. Built once, and
      // PERSISTED into LastRun so the per-agent cards survive a tab-switch / reseed
      // (previously dropped, forcing a fall-back to the flat table on reload).
      const nodes = team.runs.map(nodeReveal);
      const teamRun: LastRun = {
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
      try { setLastRun(id, resolvedUser, teamRun); } catch { /* run-only consumer: persist best-effort */ }
      return NextResponse.json({
        running,
        mode: 'live',
        team: true,
        ok: teamOk,
        path: team.path,
        finalText: team.finalText,
        nodes,
      });
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
    if (resolvedId) clearActivity(resolvedId);
  }
}
