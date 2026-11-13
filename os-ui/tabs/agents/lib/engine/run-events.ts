/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Run event bus — the live events of one run, re-attachable after the request ends
 * USER STORY: As the Run panel I want to watch a run that PARKED on an approval finish when the
 *             decision — taken in Governance, in another request — resumes it: I re-attach to the
 *             run's stream and see node-started / tool-step / resumed / done exactly as if I had
 *             never left. As the resume orchestration I need somewhere to publish those events.
 * ARCHITECTURE:
 *   - In-process, per-runId pub/sub pinned on `globalThis` (Next bundles route handlers separately
 *     and dev HMR re-evaluates modules). Each run keeps a bounded replay buffer so a late attach
 *     gets what it missed, and a terminal `done`/`error` closes the topic (kept for a grace period
 *     so a re-attach after completion still receives the result). Single-replica by design (the
 *     checkpointer and the run itself are too — see `docs/components/os-ui.md`); A4's worker moves
 *     events to `run_events` rows.
 *   - Pure: no `server-only`, no env — the route and the resume module import it; tests drive it.
 */

export type RunEvent = { event: string; data: unknown; at: number };

type Topic = {
  buffer: RunEvent[];
  listeners: Set<(ev: RunEvent) => void>;
  closed: boolean;
  closedAt?: number;
  /** Who may attach: the run's system + runner (set by `openRunTopic`). */
  owner?: RunOwner;
};

/** The run's owner stamp (mirrors `approval-port.ts` `RunOwner`; duplicated to keep this module leaf). */
export type RunOwner = { systemId: string; userId: string; domain: string };

type Bus = { topics: Map<string, Topic> };

const BUS_KEY = Symbol.for('soa.agents.run-events');
function bus(): Bus {
  const g = globalThis as unknown as Record<symbol, Bus | undefined>;
  if (!g[BUS_KEY]) g[BUS_KEY] = { topics: new Map() };
  return g[BUS_KEY]!;
}

/** Replay buffer per run (events). The route's SSE frames are small; a parked run has few hundred at most. */
const REPLAY_MAX = 2_000;
/** How long a finished run's topic stays attachable (ms). */
const CLOSED_TTL_MS = 10 * 60 * 1_000;
/** Terminal events — after one of these the topic closes. A `done` for a PARKED run (awaiting an
 *  approval) is NOT terminal: the decision will resume the run on the same topic. */
function isTerminal(ev: RunEvent): boolean {
  if (ev.event === 'error') return true;
  if (ev.event !== 'done') return false;
  const d = ev.data as { parked?: boolean } | null;
  return !(d && d.parked === true);
}

function topic(runId: string): Topic {
  const b = bus();
  let t = b.topics.get(runId);
  if (!t) {
    t = { buffer: [], listeners: new Set(), closed: false };
    b.topics.set(runId, t);
  }
  return t;
}

/** Drop closed topics older than the TTL (called on every publish — cheap, bounded). */
function sweep(now: number): void {
  for (const [id, t] of bus().topics) {
    if (t.closed && t.closedAt !== undefined && now - t.closedAt > CLOSED_TTL_MS) bus().topics.delete(id);
  }
}

/** Open (or re-open) a run's topic with its owner — the attach route checks it. */
export function openRunTopic(runId: string, owner: RunOwner): void {
  const t = topic(runId);
  t.owner = owner;
  t.closed = false;
  t.closedAt = undefined;
}

/** The owner a topic was opened with (undefined when unknown or swept). */
export function runTopicOwner(runId: string): RunOwner | undefined {
  return bus().topics.get(runId)?.owner;
}

/** Publish one event on a run's topic. A `done`/`error` closes the topic (later events are dropped). */
export function publishRunEvent(runId: string, event: string, data: unknown): void {
  const now = Date.now();
  sweep(now);
  const t = topic(runId);
  if (t.closed) return;
  const ev: RunEvent = { event, data, at: now };
  t.buffer.push(ev);
  if (t.buffer.length > REPLAY_MAX) t.buffer.splice(0, t.buffer.length - REPLAY_MAX);
  for (const l of t.listeners) l(ev);
  if (isTerminal(ev)) {
    t.closed = true;
    t.closedAt = now;
    t.listeners.clear();
  }
}

/** Re-open a closed topic for a resume (the run continues under the same id). The replay buffer is kept. */
export function reopenRun(runId: string): void {
  const t = topic(runId);
  t.closed = false;
  t.closedAt = undefined;
}

/**
 * Subscribe: replays the buffer, then streams live events. Returns the unsubscribe function.
 * `onEnd` fires once the topic is (or already was) closed — the SSE route ends its response there.
 */
export function subscribeRun(
  runId: string,
  onEvent: (ev: RunEvent) => void,
  onEnd?: () => void,
): () => void {
  const t = topic(runId);
  for (const ev of t.buffer) onEvent(ev);
  if (t.closed) {
    onEnd?.();
    return () => undefined;
  }
  const listener = (ev: RunEvent) => {
    onEvent(ev);
    if (isTerminal(ev)) onEnd?.();
  };
  t.listeners.add(listener);
  return () => { t.listeners.delete(listener); };
}

/** True when the run has a topic (started in this process and not yet swept). */
export function hasRunTopic(runId: string): boolean {
  return bus().topics.has(runId);
}

/** Test-only: drop every topic. */
export function __resetRunEvents(): void {
  bus().topics.clear();
}
