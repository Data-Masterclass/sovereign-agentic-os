/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * toast — the pure, framework-free core of the OS-wide "that did something" feedback.
 *
 * The UI layer (components/core/Toast.tsx) is a thin React shell over these functions:
 * a provider holds a `Toast[]` queue in state and drives it entirely through
 * `pushToast` / `dismissToast`. Keeping the queue logic here (no React, no DOM) makes
 * the rules — dedup of the newest, cap on how many stack, default per-tone dwell time —
 * unit-testable in isolation (lib/**\/*.test.ts).
 *
 * The one job of a toast: after ANY button press, make the outcome legible. A success
 * toast confirms the thing happened; an error toast says what went wrong. It never
 * blocks — it is a passive, self-dismissing confirmation, not a modal.
 */

export type ToastTone = 'success' | 'error' | 'info';

/**
 * An optional call-to-action rendered as a button inside the toast. Either a
 * navigation (`href`, e.g. the "Go to Policies & Approvals →" deep-link) or an
 * inline handler (`onClick`, e.g. "Approve now"). `busy` marks an action that runs
 * an async task with its own spinner→✓ feedback (the shell wires that). This is how
 * the OS-wide "this needs approval" confirmation stays ONE primitive.
 */
export type ToastAction = {
  label: string;
  href?: string;
  onClick?: () => void | Promise<unknown>;
  /** Give the button the ActionButton busy→✓ treatment (for async onClick). */
  busy?: boolean;
};

export type Toast = {
  id: string;
  tone: ToastTone;
  message: string;
  /** ms before auto-dismiss; 0 or undefined means "sticky, dismiss by hand". */
  duration: number;
  createdAt: number;
  /** Optional actions (primary, then secondary) rendered as buttons in the pill. */
  actions?: ToastAction[];
};

export type ToastInput = {
  tone?: ToastTone;
  message: string;
  /** Override the default dwell; pass 0 to make it sticky. */
  duration?: number;
  /** Optional actions rendered in the pill (e.g. Policies link + Approve now). */
  actions?: ToastAction[];
};

/** Most toasts that can stack at once — older ones fall off the top. */
export const MAX_TOASTS = 4;

/** Per-tone default dwell (ms). Errors linger longer because they demand a read. */
export const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 3200,
  info: 3600,
  error: 6000,
};

/** A toast that carries actions needs long enough for the user to reach for a
 *  button — it lingers before self-dismissing (still passive, never modal). */
export const ACTION_DURATION = 9000;

/** Resolve the dwell for an input: explicit value wins, else — if it carries
 *  actions — the longer action dwell, else the per-tone default. */
export function resolveDuration(input: ToastInput): number {
  if (input.duration !== undefined) return Math.max(0, input.duration);
  if (input.actions && input.actions.length > 0) return ACTION_DURATION;
  return DEFAULT_DURATION[input.tone ?? 'success'];
}

/**
 * Append a toast to the queue. Two guards keep it calm:
 *   • Dedup — if the newest live toast has the same tone+message, we DON'T stack a
 *     duplicate (double-clicks, retries); we return the queue unchanged.
 *   • Cap — never keep more than MAX_TOASTS; the oldest are dropped from the front.
 */
export function pushToast(
  queue: Toast[],
  input: ToastInput,
  now: number = Date.now(),
  id: string = makeId(now),
): Toast[] {
  const tone = input.tone ?? 'success';
  const last = queue[queue.length - 1];
  // Dedup identical newest toasts (double-click guard) — but never a toast that
  // carries actions, since its buttons make it a distinct, interactive prompt.
  const hasActions = !!input.actions && input.actions.length > 0;
  if (!hasActions && last && last.tone === tone && last.message === input.message) return queue;
  const toast: Toast = {
    id,
    tone,
    message: input.message,
    duration: resolveDuration(input),
    createdAt: now,
    ...(hasActions ? { actions: input.actions } : {}),
  };
  const next = [...queue, toast];
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
}

/** Remove a toast by id (called by the auto-dismiss timer or the close button). */
export function dismissToast(queue: Toast[], id: string): Toast[] {
  return queue.filter((t) => t.id !== id);
}

let seq = 0;
/** Collision-resistant enough for a client-side toast queue (id, not a key of record). */
export function makeId(now: number = Date.now()): string {
  seq = (seq + 1) % 1_000_000;
  return `t_${now.toString(36)}_${seq.toString(36)}`;
}
