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
 *   - DECLARED OUTPUTS are saved here, by the engine, once the graph has produced its result
 *     (`saveOutputsOf`): the report is persisted FIRST with every output `pending`, then the save
 *     runs through the governed door as the runner, then the report is persisted again with the
 *     outcome and `done` is emitted. A save that fails never fails the run — it marks it
 *     "completed with unsaved outputs". A process that dies between the two writes leaves
 *     `pending` behind; the re-queued job then finds a finished thread and `recoverOutputSave`
 *     completes the save from the checkpoint instead of answering "already finished".
 *   - `server-only`: it touches the store, config and the server wiring. The pure logic it drives
 *     (`engine/run.ts`, `engine/resume.ts`, `run-lock.ts`) is what the tests exercise.
 */
import 'server-only';
import type { RunEnv } from '@core/kernel/object-lifecycle';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { inspectOsRun, runOsTeam, type RunOsTeamResult } from '@tabs/agents/lib/build/agentic-graph-server';
import { saveRunOutputs, type OutputDoorOptions } from '@tabs/agents/lib/build/output-save-server';
import { pendingOutputs, unsavedOutputs, unsavedOutputsWarning, type OutputResult, type ProducerRun } from '@tabs/agents/lib/output-saver';
import { classifyStepError } from '@tabs/agents/lib/build/agentic-graph';
import { resolveFolderGrantsWithWarnings, summarizeWriteOutcomes, writeOutcomesLine } from '@tabs/agents/lib/build/os-tools';
import { missingGrantWarnings } from '@tabs/agents/lib/build/grant-presence';
import { withOutputTools } from '@tabs/agents/lib/output-tools';
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
import { runOutcomeOf } from '@tabs/agents/lib/engine/run-status';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';
import type { ResumeDecision } from '@tabs/agents/lib/engine/run';
import type { LivePrincipal } from '@tabs/agents/lib/engine/resume';
import { resolveSystemKey, systemKeyRef } from '@core/infra/agent-system-keys';

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
  return (await prepareRun(user, view, systemId)).yaml;
}

/**
 * {@link prepareRunYaml} plus what the RUNNER should be told about the definition before it
 * runs: a folder grant that matches nothing right now (`folderGrantWarnings`), and an item grant
 * whose target was deleted or is no longer visible (`missingGrantWarnings`). The run reads the
 * SAVED definition here, at run time — a grant changed in the builder applies to the next run
 * with no rebuild. Each declared output's write tool is handed to the agent(s) that produce it
 * (`withOutputTools`); nothing of that is stored.
 */
export async function prepareRun(
  user: CurrentUser,
  view: SystemView,
  systemId: string,
): Promise<{ yaml: string; warnings: string[] }> {
  const governed = await governYamlForOwner(view.yaml, view.owner);
  const { system, warnings } = await resolveFolderGrantsWithWarnings(user, parseSystem(governed), systemId);
  // An item grant whose target was deleted since it was granted is named here, before any agent
  // runs, rather than discovered by an agent that "cannot find" it (`grant-presence.ts`).
  const missing = await missingGrantWarnings(user, system).catch(() => []);
  return { yaml: serializeSystem(withOutputTools(system)), warnings: [...warnings, ...missing] };
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

/** The run result with the definition warnings appended to the engine's own (deduplicated). */
export function withDefinitionWarnings<T extends { warnings?: string[] }>(team: T, extra?: string[]): T {
  if (!extra || extra.length === 0) return team;
  const merged = [...(team.warnings ?? [])];
  for (const w of extra) if (!merged.includes(w)) merged.push(w);
  return { ...team, warnings: merged };
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
  // HOW IT ENDED, truthfully. A run that stopped because an agent failed is `failed` — in this
  // report, in the stored last run and (through `executeJob`) on its job row. It used to be told
  // apart only by `reachedEnd: false`, which a budget stop and an interruption share.
  const failed = !!team.failed;
  const failure = failed ? { node: team.failure?.node ?? null, reason: team.failure?.reason ?? 'an agent failed' } : undefined;
  const status = runOutcomeOf({ parked, failed, interrupted: !!team.interrupted, reachedEnd: team.reachedEnd });
  const lastRun: LastRun = {
    at: Date.now(),
    running,
    ok: teamOk && team.reachedEnd,
    path: team.path,
    reachedEnd: team.reachedEnd,
    ...(failure ? { failed: true as const, failureReason: failure.reason, ...(failure.node ? { failedNode: failure.node } : {}) } : {}),
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
    /** `done` | `failed` | `parked` | `interrupted` | `incomplete` (stopped at the step budget). */
    status,
    /** An agent failed and the run stopped there. */
    failed,
    /** Which agent failed and why — present only when `failed`. */
    failure,
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

/** The report body every door returns: the run's own report plus what happened to its declared outputs. */
export type RunReportBody = ReturnType<typeof finalizeTeamRun>['body'] & {
  /** Per declared output: saved where (id, link), promotion requested, or not saved and why. */
  outputs?: OutputResult[];
  /** The run finished, and at least one declared output was not saved. */
  completedWithUnsavedOutputs?: boolean;
};

/** A report and its stored record, with the outputs' outcome (and its warning line) applied. */
export function withOutputResults<B extends { status: string; warnings?: string[] }>(
  fin: { body: B; lastRun: LastRun },
  outputs: OutputResult[],
): { body: B & { outputs: OutputResult[]; completedWithUnsavedOutputs: boolean }; lastRun: LastRun } {
  const unsaved = fin.body.status === 'done' && unsavedOutputs(outputs).length > 0;
  const line = unsaved ? unsavedOutputsWarning(outputs) : null;
  // The line is replaced, never stacked — and it goes away once a later save succeeded.
  const others = (fin.body.warnings ?? []).filter((w) => !w.startsWith('Completed with unsaved outputs'));
  const merged = line ? [...others, line] : others;
  const warnings = merged.length > 0 || fin.body.warnings ? merged : undefined;
  return {
    body: { ...fin.body, warnings, outputs, completedWithUnsavedOutputs: unsaved },
    lastRun: { ...fin.lastRun, outputs, warnings: warnings && warnings.length > 0 ? warnings : undefined },
  };
}

/** The result of every agent visit, in order — what a declared output is saved from. */
function producerRuns(team: RunOsTeamResult): ProducerRun[] {
  return team.runs.map((r) => ({ node: r.node, status: r.status, finalText: r.result.finalText }));
}

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
  /** The Governance decision a resume carries (WP-26: keyed by interrupt id). */
  resumeDecision?: ResumeDecision;
  /** ONE-RELEASE SHIM: a pre-WP-26 job's `{ [approvalId]: decision }`. */
  resumeWith?: Record<string, ApprovalDecision>;
  /** Operator log sink (the worker's console). */
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** The request's own live channel (SSE `send`); the run topic receives the same events regardless. */
  emit?: (event: string, data: unknown) => void;
  /** For a fresh run: the prompt recorded on the durable store checkpoint. */
  prompt?: string;
  /**
   * Warnings about the definition, for the RUNNER (`prepareRun`): they are appended to the run
   * report's `warnings`. They never enter a prompt or a tool result.
   */
  definitionWarnings?: string[];
  /** Injected in tests: the door the declared outputs are saved through (`output-save-server.ts`). */
  outputDoor?: OutputDoorOptions;
  /** Injected in tests: the team run itself (a scripted graph), in place of `runOsTeam`. */
  runTeam?: typeof runOsTeam;
  /**
   * LIFECYCLE (review M-3): which point of the system's life this run is — `run` for a schedule
   * executing the PINNED definition, `test` for a verify pass, `studio` (the default) for a run
   * started by hand. It becomes the LiteLLM `env:` tag and the Langfuse trace `environment`, so
   * a draft's spend and traces never look like production's.
   */
  env?: RunEnv;
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
    // NO KEY, NO RUN — and say so before anything executes. A system that was never built (or
    // whose old, guessable key was removed and not yet replaced by a Rebuild) has no key of its
    // own; running it on the shared key would put its spend outside its own budget and limits
    // without anyone noticing. `SystemKeyUnavailableError` carries the sentence the owner needs
    // ("press Build"); the catch below publishes it as the run's error.
    await resolveSystemKey(id, { fresh: true });
    let team: RunOsTeamResult;
    try {
      team = await (input.runTeam ?? runOsTeam)({
      user,
      yaml,
      systemId: id,
      env: input.env,
      messages: input.messages,
      disabledAgents: view.disabledAgents,
      runId,
      resume: input.resume,
      resumeDecision: input.resumeDecision,
      resumeWith: input.resumeWith,
      log: input.log,
      signal: input.signal,
      // The run's model calls use THIS system's own key, by reference: the model caller reads it
      // from the durable encrypted store on every call. There is no fallback to the shared key.
      keyRef: systemKeyRef(id),
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
      onInterrupt: (ev) => emit('approval-required', { approvalId: ev.approvalId, interruptId: ev.interruptId, tool: ev.tool, node: ev.node }),
      // The agent is waiting for the model rate limit to reset — say so, so the run is not silent.
      onRateLimitWait: (ev) => emit('rate-limit-wait', { node: ev.node, attempt: ev.attempt, maxAttempts: ev.maxAttempts, waitSeconds: Math.round(ev.waitMs / 1000), message: ev.message }),
      });
    } catch (e) {
      // A re-queued job that finds its thread FINISHED: the graph is done, but the process that
      // ran it may have died before the declared outputs were saved. Finish that, once.
      const recovered = input.resume && (e as { status?: number })?.status === 409 ? await recoverOutputSave(input, emit) : null;
      if (!recovered) throw e;
      return recovered;
    }
    const running = markRunFinished(id, user);
    const fin = finalizeTeamRun(withDefinitionWarnings(team, input.definitionWarnings), running, yaml);
    const sys = parseSystem(yaml);
    if ((sys.outputs ?? []).length === 0) {
      try { setLastRun(id, user, fin.lastRun); } catch { /* run-only consumer: persist best-effort */ }
      emit('done', fin.body);
      return fin.body;
    }
    // DECLARED OUTPUTS. The report first, with every output `pending` (what this run already
    // saved before it parked stays as it was) — the analysis is on record before any write.
    const before = view.lastRun?.runId === runId ? view.lastRun.outputs : undefined;
    const finished = fin.body.status === 'done' && !input.signal?.aborted;
    if (finished) {
      const waiting = pendingOutputs(sys).map((p) => before?.find((b) => b.key === p.key && b.state === 'saved') ?? p);
      try { setLastRun(id, user, { ...fin.lastRun, outputs: waiting }); } catch { /* persist best-effort */ }
      emit('outputs-saving', { outputs: waiting });
    }
    const outputs = await saveRunOutputs({
      user,
      system: sys,
      systemId: id,
      runId,
      at: fin.lastRun.at,
      status: input.signal?.aborted && fin.body.status === 'done' ? 'interrupted' : fin.body.status,
      failure: fin.body.failure ? { node: fin.body.failure.node, reason: fin.body.failure.reason } : undefined,
      nodes: producerRuns(team),
      previous: before,
      ...input.outputDoor,
    });
    const { body, lastRun } = withOutputResults(fin, outputs);
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

/**
 * A `resume` reached a thread that already FINISHED. That is a conflict (409) — unless this is the
 * run whose declared outputs were never recorded as saved: the worker died between the graph's
 * end and the bookkeeping. Then the save is completed here, from the checkpoint's own per-agent
 * results, and the run reports as done. The saver looks for what the run already wrote before it
 * writes anything, so nothing is saved a second time.
 *
 * Returns null when there is nothing to recover — the caller then throws the 409 as before. Only
 * the system's CURRENT last run qualifies: an older run is never re-saved over a newer one.
 */
async function recoverOutputSave(input: ExecuteTeamRunInput, emit: (event: string, data: unknown) => void): Promise<RunReportBody | null> {
  const { user, systemId: id, view, yaml, runId } = input;
  const sys = parseSystem(yaml);
  const last = view.lastRun;
  if ((sys.outputs ?? []).length === 0 || !last || last.runId !== runId) return null;
  const unfinished = !last.outputs || last.outputs.some((o) => o.state === 'pending');
  if (!unfinished) return null;
  const run = await inspectOsRun({ user, yaml, systemId: id, runId });
  if (!run.exists || !run.finished || run.failed || run.budget.exhausted || run.nodes.length === 0) return null;
  const at = last.outputs ? last.at : Date.now();
  const outputs = await saveRunOutputs({
    user, system: sys, systemId: id, runId, at, status: 'done', nodes: run.nodes, previous: last.outputs, ...input.outputDoor,
  });
  const running = markRunFinished(id, user);
  const base: LastRun = {
    ...last,
    at,
    running,
    ok: true,
    reachedEnd: true,
    interrupted: undefined,
    path: run.path,
    output: run.finalText,
    nodes: last.nodes && last.nodes.length >= run.nodes.length ? last.nodes : run.nodes.map((n) => ({ node: n.node, status: n.status, finalText: n.finalText, steps: [] })),
  };
  const fin = withOutputResults({ body: { status: 'done', warnings: last.warnings }, lastRun: base }, outputs);
  try { setLastRun(id, user, fin.lastRun); } catch { /* persist best-effort */ }
  const body = {
    running,
    mode: 'live' as const,
    engine: 'langgraph' as const,
    runId,
    checkpointer: base.checkpointer,
    traceUrl: base.traceUrl,
    traceStoreAvailable: base.traceStoreAvailable,
    warnings: fin.body.warnings,
    interrupted: false,
    parked: false,
    heldApprovals: [],
    team: true,
    ok: true,
    status: 'done' as const,
    failed: false,
    failure: undefined,
    reachedEnd: true,
    path: run.path,
    finalText: run.finalText,
    nodes: (base.nodes ?? []).map((n) => ({
      node: n.node, model: n.model ?? '', tier: n.tier, tierReason: n.tierReason, status: n.status, error: n.error, input: n.input,
      finalText: n.finalText ?? '',
      steps: (n.steps ?? []).map((st) => ({ tool: st.tool, isError: !!st.isError, errorKind: undefined, summary: st.summary ?? '', args: st.args ?? '', result: st.result ?? '' })),
    })),
    contextUsage: base.contextUsage ?? deriveContextUsage([]),
    grantedIds: base.grantedIds ?? grantedIdsFromYaml(yaml),
    writeSummary: base.writeSummary ?? { line: '', wrote: [], wroteTotal: 0, heldTotal: 0 },
    outputs,
    completedWithUnsavedOutputs: fin.body.completedWithUnsavedOutputs,
  } as RunReportBody;
  emit('done', body);
  return body;
}

/** The `CurrentUser` a live principal acts as (all domains active; the runner chose no narrower scope). */
export function currentUserOf(p: LivePrincipal): CurrentUser {
  return { id: p.id, name: p.name, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role };
}

/* The decide() hook's resume moved to `build/run-jobs-server.ts` `enqueueResumeAfterDecision` in
 * A4: a decision FILES a `resume` job (executed by the worker, or in this process under
 * `AGENTS_WORKER=inline`) instead of driving the graph inside the decider's request. */
