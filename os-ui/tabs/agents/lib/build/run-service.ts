/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Run service — start, resume and finalise one team run the same way from every door
 * USER STORY: As the run route, the MCP tools and the approval-resume hook I want ONE place that
 *             prepares the governed yaml, drives `runOsTeam`, mirrors the live events onto the run's
 *             event topic (so a panel can re-attach to a parked run), persists `LastRun` and shapes
 *             the report — so a run looks identical whether it started from the UI, from MCP, or was
 *             resumed by a Governance decision in another request.
 * ARCHITECTURE:
 *   - `prepareRunYaml` = the route's two live re-assertions (owner-role grant downgrade + folder
 *     grant late-binding). `finalizeTeamRun`/`nodeReveal` moved here from the route unchanged (+ the
 *     A2 fields `parked`, `heldApprovals`, `warnings`). `executeTeamRun` wires hooks → store
 *     checkpoints + `emit` (the request's SSE) + `publishRunEvent` (the re-attachable topic), then
 *     completes (`setRunning` false, `setLastRun`). `resumeOsRunAfterDecision` is what the decide()
 *     hook calls: it rebuilds the context AS THE LIVE RUNNER and resumes with the decision.
 *   - A4: `executeTeamRun` is no longer called from a route. The run QUEUE
 *     (`build/run-jobs-server.ts`) calls it — inline in the enqueueing process, or in the
 *     `os-ui-worker` pod — and mirrors every event into `run_events`.
 *   - IN-FLIGHT LOCK (A2 review M-B): one thread runs in one process at a time. `executeTeamRun`
 *     acquires a `globalThis`-pinned lock on the run id and releases it in `finally`; a second
 *     entrant (the owner's `POST {resume}` racing a decision-driven resume, or two deciders) gets a
 *     typed `RunInFlightError` (409) instead of re-running `tools_<id>` and executing an approved
 *     write twice. Single replica, like the checkpointer; A4's worker moves this to `run_jobs`.
 *   - `server-only`: it touches the store, config and the server wiring. The pure logic it drives
 *     (`engine/run.ts`, `engine/resume.ts`, `run-lock.ts`) is what the tests exercise.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { runOsTeam, type RunOsTeamResult } from '@tabs/agents/lib/build/agentic-graph-server';
import { classifyStepError } from '@tabs/agents/lib/build/agentic-graph';
import { resolveFolderGrantsForRun, summarizeWriteOutcomes, writeOutcomesLine } from '@tabs/agents/lib/build/os-tools';
import { governYamlForOwner } from '@tabs/agents/lib/build/owner-grants';
import { deriveContextUsage } from '@tabs/agents/lib/build/context-usage';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import {
  checkpointNode,
  clearActivity,
  recordActivity,
  setActivity,
  setLastRun,
  setRunning,
  startRunCheckpoint,
  type LastRun,
  type SystemView,
} from '@tabs/agents/lib/store';
import { openRunTopic, publishRunEvent } from '@tabs/agents/lib/engine/run-events';
import { acquireRunLock } from '@tabs/agents/lib/engine/run-lock';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';
import type { LivePrincipal } from '@tabs/agents/lib/engine/resume';

type ChatMsg = { role: 'user' | 'assistant'; content: string };

/** The checkpointer kind the platform config selects (the same decision `selectCheckpointer` makes). */
export function configuredCheckpointer(): 'postgres' | 'memory' {
  return (config.agentRunsDatabaseUrl ?? '').trim() ? 'postgres' : 'memory';
}

/**
 * The governed yaml a run executes: the owner's CURRENT role re-asserted over the grants (a stale
 * direct-write grant downgrades to held), then folder grants late-bound to the acting user's live
 * DLS-scoped lists. Both read live, never trusted from the saved yaml.
 */
export async function prepareRunYaml(user: CurrentUser, view: SystemView, systemId: string): Promise<string> {
  const governed = await governYamlForOwner(view.yaml, view.owner);
  return serializeSystem(await resolveFolderGrantsForRun(user, parseSystem(governed), systemId));
}

/** A one-line, single-line result summary for a tool step (observability, kept tight). */
export function summarizeResult(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Bound a full step field (tool args JSON / raw result) for the drill-down. */
function boundField(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/** The per-node reveal shape returned to the UI (and persisted into LastRun). */
export function nodeReveal(r: {
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
    tier: r.tier,
    tierReason: r.tierReason,
    status: r.status,
    error: r.error,
    input: r.input ? boundField(r.input, 8_000) : undefined,
    finalText: r.result.finalText,
    steps: r.result.steps.map((s) => ({
      tool: s.tool,
      isError: s.isError,
      errorKind: s.isError ? classifyStepError(s.result) : undefined,
      summary: summarizeResult(s.result),
      args: boundField(JSON.stringify(s.args ?? {})),
      result: boundField(s.result),
    })),
  };
}

/** The system's declared grant ids per kind (best-effort; an unparseable yaml yields empty lists). */
function grantedIdsFromYaml(yaml: string) {
  try {
    const g = parseSystem(yaml).grants;
    return {
      data: g.data.map((x) => x.id),
      knowledge: g.knowledge.map((x) => x.id),
      files: [] as string[],
      metrics: g.metrics.map((x) => x.id),
      connections: g.connections.map((x) => x.id),
    };
  } catch {
    return { data: [], knowledge: [], files: [], metrics: [], connections: [] };
  }
}

/**
 * Finalize a team run into (a) the JSON body every door returns and (b) the `LastRun` record. ONE
 * function so the streamed `done` frame, the JSON response and a hook-driven resume agree.
 */
export function finalizeTeamRun(team: RunOsTeamResult, running: boolean, yaml: string) {
  const teamSteps = team.runs.flatMap((r) =>
    r.result.steps.map((s) => ({
      node: r.node,
      effect: !s.isError ? 'allow' : classifyStepError(s.result) === 'policy' ? 'deny' : 'error',
      tool: s.tool,
      ran: true,
    })),
  );
  const teamOk = team.runs.every((r) => r.status === 'ok');
  const nodes = team.runs.map(nodeReveal);
  const contextUsage = deriveContextUsage(team.runs.map((r) => ({ steps: r.result.steps })));
  const grantedIds = grantedIdsFromYaml(yaml);
  const outcomes = summarizeWriteOutcomes(
    team.runs.flatMap((r) => r.result.steps.map((s) => ({ tool: s.tool, result: s.result, isError: s.isError }))),
  );
  const heldApprovals = team.heldApprovals ?? [];
  const parked = heldApprovals.length > 0;
  const writeSummary = { line: writeOutcomesLine(outcomes), ...outcomes };
  const lastRun: LastRun = {
    at: Date.now(),
    running,
    ok: teamOk && team.reachedEnd,
    path: team.path,
    reachedEnd: team.reachedEnd,
    traces: 0,
    // Held = write outcomes the model saw as held + the approvals a parked run is waiting on (A2).
    held: outcomes.heldTotal + heldApprovals.length,
    steps: teamSteps,
    nodes,
    contextUsage,
    grantedIds,
    output: team.finalText,
    writeSummary,
    mode: 'live',
    runId: team.runId,
    engine: 'langgraph',
    checkpointer: team.checkpointer,
    interrupted: team.interrupted || undefined,
    heldApprovals: parked ? heldApprovals : undefined,
    warnings: team.warnings && team.warnings.length > 0 ? team.warnings : undefined,
    // A3: the deep link to THIS run's Langfuse trace (id = run id), offered only when it was recorded.
    traceStoreAvailable: team.traceStoreAvailable,
    traceUrl: team.traceUrl,
  };
  const body = {
    running,
    mode: 'live' as const,
    engine: 'langgraph' as const,
    runId: team.runId,
    checkpointer: team.checkpointer,
    traceUrl: team.traceUrl,
    traceStoreAvailable: team.traceStoreAvailable,
    warnings: team.warnings,
    interrupted: team.interrupted,
    // A2: a parked run and what it waits on — the decision in Governance resumes it.
    parked,
    heldApprovals,
    team: true,
    ok: teamOk && team.reachedEnd,
    reachedEnd: team.reachedEnd,
    path: team.path,
    finalText: team.finalText,
    nodes,
    contextUsage,
    grantedIds,
    writeSummary,
  };
  return { body, lastRun };
}

export type RunReportBody = ReturnType<typeof finalizeTeamRun>['body'];

/** Mark the run FINISHED (clear the running flag for editors; record activity for run-only consumers). */
function markRunFinished(id: string, user: CurrentUser): boolean {
  try {
    return setRunning(id, user, false).running;
  } catch {
    recordActivity(id);
    return false;
  }
}

export type ExecuteTeamRunInput = {
  user: CurrentUser;
  systemId: string;
  view: SystemView;
  /** The prepared (governed) yaml — `prepareRunYaml`. */
  yaml: string;
  messages: ChatMsg[];
  runId: string;
  resume?: boolean;
  resumeWith?: Record<string, ApprovalDecision>;
  signal?: AbortSignal;
  /** The request's own live channel (SSE `send`); the run topic receives the same events regardless. */
  emit?: (event: string, data: unknown) => void;
  /** For a fresh run: the prompt recorded on the durable store checkpoint. */
  prompt?: string;
};

/**
 * Drive one team run (start or resume) end to end: activity + store checkpoints, live events to the
 * request AND the run topic, completion (running flag, LastRun). Returns the report body. Throws
 * the engine's typed errors (`ResumeNotFoundError` 404, `RunAlreadyFinishedError` 409) BEFORE any
 * event is published for a refused resume.
 */
export async function executeTeamRun(input: ExecuteTeamRunInput): Promise<RunReportBody> {
  const { user, systemId: id, view, yaml, runId } = input;
  const owner = { systemId: id, userId: user.id, domain: view.system.system.domain };
  // A2 review M-B: one entrant per thread. Thrown BEFORE any marker or event — a refused entrant
  // never looks like a run. Released in `finally` below.
  const release = acquireRunLock(runId);
  const emit = (event: string, data: unknown) => {
    input.emit?.(event, data);
    publishRunEvent(runId, event, data);
  };
  openRunTopic(runId, owner);
  setActivity(id, { kind: 'running', startedAt: Date.now() });
  if (!input.resume) {
    startRunCheckpoint(id, {
      prompt: input.prompt,
      plannedNodes: view.system.agents.map((a) => a.id),
      runId,
      checkpointer: configuredCheckpointer(),
    });
  }
  try {
    const team = await runOsTeam({
      user,
      yaml,
      systemId: id,
      messages: input.messages,
      disabledAgents: view.disabledAgents,
      runId,
      resume: input.resume,
      resumeWith: input.resumeWith,
      signal: input.signal,
      // A3: the system's own LiteLLM key by reference, when Build minted one; else the shared agent key.
      keyRef: view.lastBuild?.litellmKeyRef,
      onNodeStart: (ev) => {
        try { checkpointNode(id, { phase: 'start', node: ev.node }); } catch { /* best-effort */ }
        emit('node-started', ev);
      },
      onStep: (ev) =>
        emit('tool-step', {
          node: ev.node,
          tool: ev.step.tool,
          status: !ev.step.isError ? 'ok' : classifyStepError(ev.step.result) === 'policy' ? 'denied' : 'error',
          index: ev.index,
        }),
      onNodeComplete: (ev) => {
        try { checkpointNode(id, { phase: 'complete', node: ev.node, status: ev.status, finalText: ev.finalText }); } catch { /* best-effort */ }
        emit('node-completed', { node: ev.node, status: ev.status, finalTextPreview: summarizeResult(ev.finalText) });
      },
      // A2: a held write parked the run — the panel shows it; the decision in Governance resumes it.
      onInterrupt: (ev) => emit('approval-required', { approvalId: ev.approvalId, tool: ev.tool, node: ev.node }),
    });
    const running = markRunFinished(id, user);
    const { body, lastRun } = finalizeTeamRun(team, running, yaml);
    try { setLastRun(id, user, lastRun); } catch { /* run-only consumer: persist best-effort */ }
    emit('done', body);
    return body;
  } catch (e) {
    const err = e as Error & { status?: number };
    // A refused resume (404/409) never happened as a run — nothing to publish on the topic.
    if (err?.status !== 404 && err?.status !== 409) emit('error', { error: err.message });
    throw e;
  } finally {
    clearActivity(id);
    release();
  }
}

/** The `CurrentUser` a live principal acts as (all domains active; the runner chose no narrower scope). */
export function currentUserOf(p: LivePrincipal): CurrentUser {
  return { id: p.id, name: p.name, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role };
}

/* The decide() hook's resume moved to `build/run-jobs-server.ts` `enqueueResumeAfterDecision` in
 * A4: a decision FILES a `resume` job (executed by the worker, or in this process under
 * `AGENTS_WORKER=inline`) instead of driving the graph inside the decider's request. */
