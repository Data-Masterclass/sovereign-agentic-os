/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The workflow editor's serial commit queue
 * USER STORY: As a process owner I must be able to make two edits in a row and have both land —
 *             and be told when one fails, instead of an edit vanishing without a word.
 * ARCHITECTURE:
 *   - The editor used to DROP a commit arriving while the previous commit+reload was in flight
 *     (`if (actingRef.current) return;`). Every field committed on blur, so "edit then click"
 *     silently lost the edit. Here a commit is appended to a promise chain instead.
 *   - Serial on purpose: each commit re-reads the sha (`commitWorkflow`), so two overlapping
 *     commits would make the second a 409. Queueing is what makes "one source" safe to edit fast.
 *   - Resolves an outcome, never throws, and reports every failure — a failing commit does not
 *     block the ones behind it.
 *   - Pure helper in `lib/` so it is unit-testable: a test cannot import the `.tsx` that uses it.
 */

export type CommitOutcome = { ok: true } | { ok: false; error: string };

export type CommitQueueHooks = {
  /** Called once per failure, with the message to show the user. */
  onError?: (message: string) => void;
  /** Called on each 0→n / n→0 transition, to drive a spinner. */
  onBusyChange?: (busy: boolean) => void;
};

export type CommitQueue = {
  /** Append a commit. Resolves when it has run — never drops it, never throws. */
  enqueue: (task: () => Promise<void>) => Promise<CommitOutcome>;
  /** How many commits are queued or running. */
  readonly pending: number;
  /** True while anything is queued or running. */
  readonly busy: boolean;
};

function message(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const s = typeof e === 'string' ? e : String(e);
  return s.trim() || 'Save failed';
}

/** Create a queue that runs its commits one at a time, in the order they arrived. */
export function createCommitQueue(hooks: CommitQueueHooks = {}): CommitQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  return {
    get pending() { return pending; },
    get busy() { return pending > 0; },
    enqueue(task: () => Promise<void>): Promise<CommitOutcome> {
      if (pending === 0) hooks.onBusyChange?.(true);
      pending += 1;
      const run: Promise<CommitOutcome> = tail.then(async () => {
        try {
          await task();
          return { ok: true } as CommitOutcome;
        } catch (e) {
          const error = message(e);
          hooks.onError?.(error);
          return { ok: false, error } as CommitOutcome;
        } finally {
          pending -= 1;
          if (pending === 0) hooks.onBusyChange?.(false);
        }
      });
      // The chain itself must never reject, or one failure would poison the queue.
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
