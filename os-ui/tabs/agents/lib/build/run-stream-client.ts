/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Run panel's SSE reader and its re-attach decision — testable, outside the TSX
 * USER STORY: As a builder watching a long run I never see "please run again" because the server's
 *             240-second tail budget ran out: the panel re-attaches to the run's event log from the
 *             exact cursor the server handed it and keeps watching, as many times as the run needs,
 *             until the run really ends.
 * ARCHITECTURE:
 *   - PURE (no DOM, no fetch, no React), so the two things that were wrong in the panel are unit-
 *     tested: FRAME PARSING (an SSE frame can be split across network chunks) and the RE-ATTACH
 *     DECISION (a `queued` frame is a cursor, not a failure; a parked `done` is not an ending).
 *   - `queued` is emitted by BOTH run doors — `POST …/run` at its tail budget and
 *     `GET …/run/stream` at its own — carrying `{ runId, afterSeq }`. `reattachFrom` turns that
 *     into the next URL; `REATTACH_LIMIT` bounds the chain so a pathological loop cannot spin
 *     forever (240 s × 40 is ~2.6 hours of run).
 *   - A4-review-M-3: before this, the panel had no `queued` handler at all — the frame fell through
 *     to "the run stream ended before a result arrived — please run again", which was a lie, and
 *     the re-attach it did do asked for `afterSeq=0` and replayed the whole run.
 */

/** One decoded SSE frame. */
export type SseFrame = { event: string; data: Record<string, unknown> };

/** How many times a panel will follow a `queued` cursor before it gives up and says so. */
export const REATTACH_LIMIT = 40;

/**
 * Decode every COMPLETE frame in `buffer + chunk`, returning the frames and the incomplete tail to
 * carry into the next read. A frame without both an `event:` and a `data:` line, or with
 * unparseable JSON, is skipped — never thrown, never half-applied.
 */
export function parseSseChunk(buffer: string, chunk: string): { frames: SseFrame[]; rest: string } {
  const parts = (buffer + chunk).split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const part of parts) {
    const lines = part.split('\n');
    const evLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!evLine || !dataLine) continue;
    try {
      frames.push({ event: evLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown> });
    } catch {
      /* a frame we cannot read is dropped, not fatal */
    }
  }
  return { frames, rest };
}

/** The re-attach stream for one run, from a cursor (`afterSeq=0` replays everything). */
export function runStreamUrl(systemId: string, runId: string, afterSeq = 0): string {
  return `/api/agents/systems/${encodeURIComponent(systemId)}/run/stream?runId=${encodeURIComponent(runId)}&afterSeq=${Math.max(0, Math.floor(afterSeq) || 0)}`;
}

export type Reattach = { runId: string; afterSeq: number };

/**
 * Should this frame make the panel re-attach, and from where? A `queued` frame carries the cursor
 * the server reached; anything else is a normal frame. The `runId` falls back to the run the panel
 * is already following, because a `queued` frame from the POST door names the same run.
 */
export function reattachFrom(frame: SseFrame, currentRunId?: string): Reattach | null {
  if (frame.event !== 'queued') return null;
  const runId = typeof frame.data.runId === 'string' && frame.data.runId ? frame.data.runId : currentRunId;
  if (!runId) return null;
  const seq = typeof frame.data.afterSeq === 'number' ? frame.data.afterSeq : 0;
  return { runId, afterSeq: Math.max(0, Math.floor(seq) || 0) };
}

/**
 * Is this frame the END of the run for a watcher? `error` is. `done` is — UNLESS it says
 * `parked: true`, which means a held write is awaiting a decision that will resume the same run on
 * the same id (mirrors `engine/jobs.ts` `isTerminalEvent`, which is the server's half of this).
 */
export function isRunOver(frame: SseFrame): boolean {
  if (frame.event === 'error') return true;
  if (frame.event !== 'done') return false;
  return frame.data.parked !== true;
}
