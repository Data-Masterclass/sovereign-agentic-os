/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Overlay dismiss safety net (os-ui 0.6.139).
 *
 * A full-screen fixed overlay/backdrop must ALWAYS be escapable — a platform
 * owner once got trapped behind the black embedded-tool overlay (`.toolwin`,
 * z-index 1000, covering the whole app incl. the left nav) with no obvious way
 * out. The invariant, enforced here in ONE pure place so every overlay shares it:
 *
 *   1. Pressing Escape closes the overlay.
 *   2. Clicking the BACKDROP (the area outside the panel/card) closes it.
 *
 * These helpers are pure + DOM-event-shaped (no React, no side effects beyond the
 * caller's `onClose`), so they're unit-testable and reusable by any overlay.
 */

/** Does this keyboard event represent an Escape press that should dismiss? */
export function isEscapeKey(e: { key?: string }): boolean {
  return e.key === 'Escape' || e.key === 'Esc';
}

/**
 * True when a click/mousedown on a backdrop element should dismiss the overlay —
 * i.e. the event fired on the backdrop itself, not on a child panel inside it.
 * Callers pass `e.target === e.currentTarget`-shaped nodes; this centralises the
 * "clicked the scrim, not the card" test so no overlay forgets it.
 */
export function isBackdropClick(target: unknown, currentTarget: unknown): boolean {
  return target != null && target === currentTarget;
}

/**
 * Attach a document-level Escape listener that calls `onClose`. Uses CAPTURE so a
 * focused same-origin iframe/child can't fully swallow the key before we see it
 * (the exact way the embedded-tool overlay could get stuck). Returns a cleanup fn.
 *
 * Guarded for SSR / non-DOM environments (returns a no-op cleanup).
 */
export function onEscape(onClose: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = (e: KeyboardEvent) => {
    if (isEscapeKey(e)) {
      e.preventDefault();
      onClose();
    }
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
}
