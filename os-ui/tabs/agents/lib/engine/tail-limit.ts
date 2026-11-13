/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A ceiling on how many run tails one pod holds open at once
 * USER STORY: As an operator I want a pod with hundreds of open Run panels to refuse the next tail
 *             honestly — 503 with `Retry-After` — instead of exhausting its Postgres pool and
 *             making every OTHER request in the pod (sign-in included) time out.
 * ARCHITECTURE:
 *   - Each tail holds one long-lived request AND polls `run_events` every 400 ms, so each one
 *     borrows a pool connection for a moment every tick. The `pg` pool is `max: 6`, shared with
 *     the checkpointer — the cap is what keeps the tails from being the pod's whole workload.
 *   - PURE: a counter pinned on `globalThis` (Next bundles each route handler separately, so a
 *     module-level counter would be per-bundle, not per-pod) and a typed 503. No config, no store.
 *   - `acquireTail()` returns the RELEASE function; routes call it in a `finally`, so a client
 *     disconnect frees the slot immediately.
 */

/** Tails one pod serves at once. Chosen against `pg` `max: 6` + a 400 ms poll, not measured load. */
export const MAX_CONCURRENT_TAILS = 64;

/** The pod is already holding `MAX_CONCURRENT_TAILS` — retry, do not queue. */
export class TooManyTailsError extends Error {
  status: number;
  retryAfterSeconds: number;
  constructor(open: number) {
    super(`This pod is already streaming ${open} runs — retry in a moment (the run itself is unaffected)`);
    this.name = 'TooManyTailsError';
    this.status = 503;
    this.retryAfterSeconds = 5;
  }
}

type Slot = { open: number };
const slot = globalThis as unknown as { __osRunTails?: Slot };

/** How many tails this pod currently holds. */
export function openTails(): number {
  slot.__osRunTails ??= { open: 0 };
  return slot.__osRunTails.open;
}

/** Take a tail slot, or throw {@link TooManyTailsError}. Returns the (idempotent) release. */
export function acquireTail(max: number = MAX_CONCURRENT_TAILS): () => void {
  slot.__osRunTails ??= { open: 0 };
  const s = slot.__osRunTails;
  if (s.open >= max) throw new TooManyTailsError(s.open);
  s.open += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.open = Math.max(0, s.open - 1);
  };
}

/** Test seam: forget the counter. */
export function resetTails(): void {
  slot.__osRunTails = { open: 0 };
}
