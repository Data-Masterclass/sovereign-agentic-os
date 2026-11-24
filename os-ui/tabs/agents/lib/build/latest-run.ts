/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Which run does the Run panel show on page load — read from the run store
 * USER STORY: As a builder who opens an agent system I want the panel to show MY latest run of it,
 *             with that run's own tool calls, context and result — not whatever run the web
 *             process happened to remember from before the runs moved to the worker.
 * ARCHITECTURE:
 *   - WHY: the "last run" used to be read from the system record held in the os-ui process's
 *     memory. Runs execute in `os-ui-worker`; its `setLastRun` updates the WORKER's copy of the
 *     record (and the mirror), and os-ui never re-reads a record it already holds — so os-ui kept
 *     serving the last run it had seen itself (typically the one it hydrated at boot), next to a
 *     newer run the panel had just streamed.
 *   - The durable source is the run store both processes share (`run_jobs` + `run_events`, the
 *     same rows `get_agent_run` and the panel's stream read): the latest job of this system BY
 *     THIS USER, and the `done` frame that job wrote — the same report body the live stream
 *     delivers, so a reload shows exactly what the stream showed.
 *   - PURE: it takes the store PORT, so it is tested against `memoryRunJobStore`. The server
 *     wiring (which store, fail-soft) is `latest-run-server.ts`.
 *   - Requester-scoped by construction (`latestForSystem(systemId, userId)`): a run's contents are
 *     its runner's only (`engine/run-visibility.ts`).
 *   - Its DECLARED OUTPUTS come from the same log: the `done` frame's `outputs`, replaced by a
 *     later `outputs-saved` event when the person saved again by hand (`latestOutputsOf`).
 *   - A run that is queued/running has no result yet: it is reported as `inFlight` and NO earlier
 *     run is offered in its place. A run that ended without a report (refused, crashed) is a
 *     failed run with the job's reason — never silently replaced by the run before it.
 */
import type { LastRun } from '@tabs/agents/lib/store';
import type { RunJob, RunJobStore, RunEventRow } from '@tabs/agents/lib/engine/jobs';
import { withSavedOutputs } from '@tabs/agents/lib/build/write-summary';

/** Where the shown run was read from — the run store, or (fallback) the system record. */
export type ShownRunSource = 'run-store' | 'system-record';

/** A stored run as the panel receives it: the `LastRun` shape plus when it started and its source. */
export type ShownRun = LastRun & { startedAt?: number; source: ShownRunSource };

export type InFlightRun = { runId: string; startedAt: number };

export type LatestRunView = { lastRun: ShownRun | null; inFlight: InFlightRun | null };

/** How many trailing events are read to find a run's report (`done` is the last or near-last frame). */
const TAIL = 50;

type StoredNode = NonNullable<LastRun['nodes']>[number];
type DoneStep = StoredNode['steps'][number] & { errorKind?: string };
type DoneNode = Omit<StoredNode, 'steps'> & { steps?: DoneStep[] };
type DoneBody = {
  ok?: boolean;
  path?: unknown;
  reachedEnd?: boolean;
  finalText?: unknown;
  nodes?: DoneNode[];
  contextUsage?: LastRun['contextUsage'];
  grantedIds?: LastRun['grantedIds'];
  writeSummary?: LastRun['writeSummary'];
  checkpointer?: LastRun['checkpointer'];
  traceUrl?: string;
  traceStoreAvailable?: boolean;
  warnings?: unknown;
  interrupted?: boolean;
  parked?: boolean;
  heldApprovals?: LastRun['heldApprovals'];
  failed?: boolean;
  failure?: { node?: string | null; reason?: string };
  outputs?: unknown;
};

/** What a later by-hand save of the run's outputs recorded (`outputs-saved` event). */
type OutputsSavedBody = { outputs?: unknown; warnings?: unknown };

/** The stored-run shape of one job's `done` report — every field from THIS run's own frame. */
export function shownRunFromDone(job: Pick<RunJob, 'runId' | 'createdAt' | 'status' | 'error'>, done: Pick<RunEventRow, 'data' | 'at'>): ShownRun {
  const b = (done.data && typeof done.data === 'object' ? done.data : {}) as DoneBody;
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map((n) => ({ ...n, steps: Array.isArray(n.steps) ? n.steps : [] }));
  const steps = nodes.flatMap((n) =>
    n.steps.map((s) => ({
      node: n.node,
      tool: s.tool,
      effect: !s.isError ? 'allow' : s.errorKind === 'policy' ? 'deny' : 'error',
      ran: true,
    })),
  );
  const heldApprovals = Array.isArray(b.heldApprovals) ? b.heldApprovals : [];
  // A job the reaper failed AFTER its last report (a parked run whose lease then expired) is a
  // failed run, whatever that earlier report said.
  const failedAfterReport = job.status === 'failed' && b.failed !== true;
  const failed = b.failed === true || failedAfterReport;
  const failureReason = failedAfterReport ? job.error ?? 'the run failed' : b.failure?.reason;
  const parked = !failed && heldApprovals.length > 0;
  return {
    at: done.at,
    startedAt: job.createdAt,
    source: 'run-store',
    running: false,
    ok: b.ok === true && !failed,
    path: Array.isArray(b.path) ? (b.path as string[]) : [],
    reachedEnd: b.reachedEnd,
    ...(failed ? { failed: true as const, failureReason: failureReason ?? 'an agent failed', ...(b.failure?.node ? { failedNode: b.failure.node } : {}) } : {}),
    traces: 0,
    held: (b.writeSummary?.heldTotal ?? 0) + (parked ? heldApprovals.length : 0),
    steps,
    nodes: nodes.length > 0 ? nodes : undefined,
    contextUsage: b.contextUsage,
    grantedIds: b.grantedIds,
    output: typeof b.finalText === 'string' ? b.finalText : undefined,
    // A frame written before saved outputs were counted is recounted from its own outputs.
    writeSummary: b.writeSummary ? withSavedOutputs(b.writeSummary, Array.isArray(b.outputs) ? (b.outputs as { state: string }[]) : undefined) : undefined,
    mode: 'live',
    runId: job.runId,
    engine: 'langgraph',
    checkpointer: b.checkpointer,
    interrupted: b.interrupted || undefined,
    heldApprovals: parked ? heldApprovals : undefined,
    warnings: Array.isArray(b.warnings) && b.warnings.length > 0 ? (b.warnings as string[]) : undefined,
    traceStoreAvailable: b.traceStoreAvailable,
    traceUrl: b.traceUrl,
    ...(Array.isArray(b.outputs) ? { outputs: b.outputs as NonNullable<LastRun['outputs']> } : {}),
  };
}

/**
 * The run's DECLARED OUTPUTS as last recorded in its own event log: the `done` frame's list, or —
 * when the person saved again by hand afterwards — the latest `outputs-saved` event after it.
 * Returns the warnings that event carried too (the "completed with unsaved outputs" line is
 * replaced by a save that succeeded). `null` when the log holds no list.
 */
export function latestOutputsOf(events: Pick<RunEventRow, 'event' | 'data' | 'seq'>[]): { outputs: NonNullable<LastRun['outputs']>; warnings?: string[]; fromSave: boolean } | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const doneAt = ordered.filter((e) => e.event === 'done').at(-1);
  const saved = ordered.filter((e) => e.event === 'outputs-saved' && (!doneAt || e.seq > doneAt.seq)).at(-1);
  if (saved) {
    const b = (saved.data && typeof saved.data === 'object' ? saved.data : {}) as OutputsSavedBody;
    if (Array.isArray(b.outputs)) {
      const warnings = Array.isArray(b.warnings) ? (b.warnings as string[]) : undefined;
      return { outputs: b.outputs as NonNullable<LastRun['outputs']>, ...(warnings ? { warnings } : {}), fromSave: true };
    }
  }
  const d = (doneAt?.data && typeof doneAt.data === 'object' ? doneAt.data : {}) as DoneBody;
  return Array.isArray(d.outputs) ? { outputs: d.outputs as NonNullable<LastRun['outputs']>, fromSave: false } : null;
}

/**
 * The run's write summary as its own event log tells it: the `done` frame's summary, with the
 * declared outputs of the latest record (the frame, or a later by-hand save) counted in. `null`
 * when the log holds no `done` frame. The same answer `readLatestRun` gives the Run panel.
 */
export function latestWriteSummaryOf(events: Pick<RunEventRow, 'event' | 'data' | 'seq'>[]): NonNullable<LastRun['writeSummary']> | null {
  const doneAt = [...events].sort((a, b) => a.seq - b.seq).filter((e) => e.event === 'done').at(-1);
  if (!doneAt) return null;
  const d = (doneAt.data && typeof doneAt.data === 'object' ? doneAt.data : {}) as DoneBody;
  const outputs = latestOutputsOf(events)?.outputs;
  return withSavedOutputs(d.writeSummary, outputs);
}

/** A run that settled WITHOUT a report (refused before it ran, or it threw): failed, with the reason. */
export function shownRunWithoutReport(job: Pick<RunJob, 'runId' | 'createdAt' | 'updatedAt' | 'error'>, error?: Pick<RunEventRow, 'data' | 'at'>): ShownRun {
  const said = (error?.data as { error?: unknown } | null | undefined)?.error;
  return {
    at: error?.at ?? job.updatedAt,
    startedAt: job.createdAt,
    source: 'run-store',
    running: false,
    ok: false,
    path: [],
    failed: true,
    failureReason: job.error ?? (typeof said === 'string' ? said : 'the run ended without a report'),
    traces: 0,
    held: 0,
    steps: [],
    mode: 'live',
    runId: job.runId,
    engine: 'langgraph',
  };
}

/**
 * The latest run of `systemId` started by `userId`, read from the run store. `null` when the store
 * holds no run of this system for this user (never run, or pruned by retention).
 */
export async function readLatestRun(store: Pick<RunJobStore, 'latestForSystem' | 'lastSeq' | 'eventsAfter'>, systemId: string, userId: string): Promise<LatestRunView | null> {
  const job = await store.latestForSystem(systemId, userId);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') {
    return { lastRun: null, inFlight: { runId: job.runId, startedAt: job.createdAt } };
  }
  const lastSeq = await store.lastSeq(job.runId);
  const tail = await store.eventsAfter(job.runId, Math.max(0, lastSeq - TAIL), TAIL);
  const done = tail.filter((e) => e.event === 'done').at(-1);
  if (done) {
    const shown = shownRunFromDone(job, done);
    // A by-hand save after the run ("Try saving again") is the newer record of its outputs.
    const later = latestOutputsOf(tail);
    if (later?.fromSave) {
      shown.outputs = later.outputs;
      shown.warnings = later.warnings && later.warnings.length > 0 ? later.warnings : undefined;
      // The later save's outputs are the ones "Wrote N" counts.
      shown.writeSummary = withSavedOutputs(shown.writeSummary, later.outputs);
    }
    return { lastRun: shown, inFlight: null };
  }
  return { lastRun: shownRunWithoutReport(job, tail.filter((e) => e.event === 'error').at(-1)), inFlight: null };
}

/**
 * Choose between the run store's answer and the system record's `lastRun`.
 *   - No answer from the store (no rows, or unreachable) → the record's, marked as such.
 *   - A run in flight → nothing else is shown as its result.
 *   - Otherwise the store's run, unless the record holds a DIFFERENT run that ended later (a run
 *     recovered as interrupted after a restart, or one recorded before the queue kept reports).
 */
export function pickLatestRun(record: LastRun | null | undefined, fromStore: LatestRunView | null): LatestRunView {
  const recorded: ShownRun | null = record ? { ...record, source: 'system-record' } : null;
  if (!fromStore) return { lastRun: recorded, inFlight: null };
  if (fromStore.inFlight) return { lastRun: null, inFlight: fromStore.inFlight };
  const stored = fromStore.lastRun;
  if (!stored) return { lastRun: recorded, inFlight: null };
  if (recorded && recorded.runId !== stored.runId && recorded.at > stored.at) return { lastRun: recorded, inFlight: null };
  return { lastRun: stored, inFlight: null };
}
