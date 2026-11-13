/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Kernel event bus — "the identity directory changed"
 * USER STORY: As a platform owner I want adding a user to a domain to take effect in the ENGINE
 *             without a restart, and I do not want the user store to know that Trino exists.
 * ARCHITECTURE:
 *   - ONE direction only. `tabs/admin/lib/{users,domains}.ts` EMIT; `instrumentation.ts`
 *     SUBSCRIBES and wires whatever must react (today: the Trino rules reconciler). A write path
 *     therefore never imports a reconciler, `core/` never imports a tab, and a second consumer is
 *     one `onDirectoryChange` away (B3-review-H-2).
 *   - Deliberately tiny and synchronous: no payloads beyond a reason string, no ordering promises,
 *     no async listeners awaited. A listener that throws is logged and dropped so one bad consumer
 *     cannot fail a user write.
 *   - Process-local by design. A second replica reconciles from its OWN boot pass and the periodic
 *     repair pass; os-ui is single-replica today (the `os-repos` PVC is RWO).
 */

/** Every kernel event this bus carries. One member today; the union is the point. */
export type KernelEvent = 'directory-changed';

export type KernelListener = (reason: string) => void;

const listeners = new Map<KernelEvent, Set<KernelListener>>();

function setFor(event: KernelEvent): Set<KernelListener> {
  let s = listeners.get(event);
  if (!s) {
    s = new Set();
    listeners.set(event, s);
  }
  return s;
}

/** Subscribe. Returns the unsubscribe. */
export function onKernelEvent(event: KernelEvent, fn: KernelListener): () => void {
  setFor(event).add(fn);
  return () => {
    setFor(event).delete(fn);
  };
}

/** Notify every subscriber. Never throws: a broken listener must not break the write that fired it. */
export function emitKernelEvent(event: KernelEvent, reason: string): void {
  for (const fn of [...setFor(event)]) {
    try {
      fn(reason);
    } catch (err) {
      console.warn(`[os-ui] kernel event ${event}: listener failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * A user, domain or membership was created, changed, archived or deleted. `reason` is for the log
 * line only — a consumer re-reads the directory itself rather than trusting a payload.
 */
export function emitDirectoryChange(reason: string): void {
  emitKernelEvent('directory-changed', reason);
}

/** Subscribe to directory writes. */
export function onDirectoryChange(fn: KernelListener): () => void {
  return onKernelEvent('directory-changed', fn);
}

/** Test seam. */
export function _resetKernelEvents(): void {
  listeners.clear();
}
