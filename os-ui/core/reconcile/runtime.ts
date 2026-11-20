/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one place server code may run a reconcile on a timer.
 * USER STORY: As an operator I want every periodic reconcile to be scheduled through one module,
 *             so timer loops are visible in one place and can move to the pg-boss schedule
 *             (design 00 §8.3 rule 8, master plan WP for `core/reconcile/runtime.ts`) in one change.
 * ARCHITECTURE:
 *   - Interim and deliberately minimal: `scheduleEvery` wraps `setInterval` with an overlap guard
 *     (a tick never starts while the previous one is still running), `unref` (a timer never keeps
 *     the process alive) and loud logging of a rejected tick. The planned runtime replaces the
 *     body with `boss.schedule`; callers keep the same call.
 *   - First caller: the OPA state reconciler (`core/policy/opa-reconcile.ts`).
 */

/** Run `fn` every `ms` milliseconds, never overlapping itself. Returns a stop function. */
export function scheduleEvery(name: string, ms: number, fn: () => Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    fn()
      .catch((err) => console.error(`[os-ui] reconcile ${name}: tick failed — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
