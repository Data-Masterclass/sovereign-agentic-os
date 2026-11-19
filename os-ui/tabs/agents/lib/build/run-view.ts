/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Which run the Run panel is showing — one state, one label, testable outside the TSX
 * USER STORY: As a builder I always know WHICH run I am looking at (its id and start time), a
 *             stored earlier run is labelled "Last run", pressing Run empties the panel before the
 *             first event arrives, and a result is never shown next to another run's details.
 * ARCHITECTURE:
 *   - PURE (no React, no DOM). The panel keeps its shown run in `runViewReducer`:
 *       `started` — Run was pressed: the shown run is dropped at once.
 *       `result`  — a `done` frame of the run this panel is following: shown as `live`.
 *       `stored`  — the server's stored latest run (the `lastRun` prop) arrived or changed.
 *       `cleared` — ANOTHER panel of the same system started a run: drop the shown run too.
 *       `patched` — a later fact about the SHOWN run (e.g. its declared outputs were saved again
 *                   by hand): merged into it only when it is that run, never into another one.
 *   - One screen can mount two panels of one system (Run above, Evaluate below). They do not
 *     share React state, so the panel that starts a run announces it (`announceRunStarted`) and
 *     the others empty themselves in the same tick — a module-level listener set, nothing more.
 *   - WHY `stored` exists: the panel used to copy `lastRun` into state ONCE, at mount. A second
 *     panel on the same screen (the Evaluate half of "Results & diagnostics") therefore kept
 *     showing the run it mounted with, next to the run the Run half had just streamed.
 *   - `stored` never replaces what the user is watching: it is ignored while a run is in flight,
 *     and a stored run that is not newer than the live result on screen is not adopted.
 *   - `runLabel` is the one sentence that names the shown run; the time formatter is injectable so
 *     the wording is tested without a locale.
 */

export type RunSource = 'live' | 'stored';

/** The fields of a run this module reads. `at` = when its report was written; `startedAt` = when it began. */
export type RunIdentity = { runId?: string; at?: number; startedAt?: number };

export type RunViewState<R> = {
  run: R | null;
  /** `live` = this panel followed the run to its result; `stored` = read back from the server. */
  source: RunSource | null;
  startedAt: number | null;
  at: number | null;
};

export type RunViewAction<R> =
  | { type: 'started'; at: number }
  | { type: 'result'; run: R; at: number }
  | { type: 'stored'; run: (R & RunIdentity) | null; busy: boolean }
  | { type: 'cleared' }
  | { type: 'patched'; runId: string | undefined; patch: Partial<R> };

export function seedRunView<R>(stored: (R & RunIdentity) | null | undefined): RunViewState<R> {
  if (!stored) return { run: null, source: null, startedAt: null, at: null };
  return { run: stored, source: 'stored', startedAt: stored.startedAt ?? null, at: stored.at ?? null };
}

export function runViewReducer<R extends { runId?: string }>(state: RunViewState<R>, action: RunViewAction<R>): RunViewState<R> {
  if (action.type === 'started') return { run: null, source: null, startedAt: action.at, at: null };
  if (action.type === 'result') {
    // The start time is the one recorded when Run was pressed here; a run this panel attached to
    // later (a parked run, a resume) keeps the start time it was stored with.
    return { run: action.run, source: 'live', startedAt: state.startedAt, at: action.at };
  }
  if (action.type === 'cleared') return state.run === null ? state : seedRunView<R>(null);
  if (action.type === 'patched') {
    if (!state.run || (action.runId && state.run.runId && action.runId !== state.run.runId)) return state;
    return { ...state, run: { ...state.run, ...action.patch } };
  }
  // 'stored'
  if (action.busy) return state;
  const stored = action.run;
  if (!stored) return state.source === 'stored' ? seedRunView<R>(null) : state;
  if (stored === state.run) return state;
  const sameRun = !!stored.runId && stored.runId === state.run?.runId;
  if (state.source === 'live') {
    if (sameRun) return state.startedAt === null && stored.startedAt ? { ...state, startedAt: stored.startedAt } : state;
    // A stored run that is not newer than the live result on screen is an OLDER run.
    if (state.at !== null && (stored.at ?? 0) <= state.at) return state;
  }
  return seedRunView<R>(stored);
}

/** `run_1b4e28ba-2fa1-…` → `1b4e28ba` — enough to tell two runs apart at a glance. */
export function shortRunId(runId: string | undefined | null): string {
  const id = (runId ?? '').trim().replace(/^run_/, '');
  return id.slice(0, 8);
}

const defaultTime = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The line that names the shown run. A stored run reads "Last run · started <time> · run <id>"
 * (or "finished <time>" when only its end is known); the run this panel just followed reads
 * "This run · started <time> · run <id>". Empty when nothing is shown.
 */
export function runLabel(view: Pick<RunViewState<{ runId?: string }>, 'run' | 'source' | 'startedAt' | 'at'>, formatTime: (ms: number) => string = defaultTime): string {
  if (!view.run) return '';
  const parts: string[] = [view.source === 'live' ? 'This run' : 'Last run'];
  if (view.startedAt !== null) parts.push(`started ${formatTime(view.startedAt)}`);
  else if (view.at !== null) parts.push(`finished ${formatTime(view.at)}`);
  const id = shortRunId(view.run.runId);
  if (id) parts.push(`run ${id}`);
  return parts.join(' · ');
}

// ------------------------------------------------- one system, several panels --

type RunStartListener = { origin: unknown; notify: () => void };
const runStartListeners = new Map<string, Set<RunStartListener>>();

/** Be told when ANOTHER panel (a different `origin`) starts a run of `systemId`. Returns the unsubscribe. */
export function onRunStartedElsewhere(systemId: string, origin: unknown, notify: () => void): () => void {
  const entry: RunStartListener = { origin, notify };
  const set = runStartListeners.get(systemId) ?? new Set<RunStartListener>();
  set.add(entry);
  runStartListeners.set(systemId, set);
  return () => {
    set.delete(entry);
    if (set.size === 0) runStartListeners.delete(systemId);
  };
}

/** A run of `systemId` was just started by the panel `origin`: every other panel of it is told now. */
export function announceRunStarted(systemId: string, origin: unknown): void {
  for (const l of [...(runStartListeners.get(systemId) ?? [])]) {
    if (l.origin !== origin) l.notify();
  }
}
