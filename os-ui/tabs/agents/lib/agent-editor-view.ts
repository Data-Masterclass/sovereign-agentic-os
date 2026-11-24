/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The rules behind the large agent editor (keyboard, unsaved-changes guard, focus trap)
 * USER STORY: As a builder I open one agent in a big editor, press Cmd/Ctrl+S to save the prompt I
 *             am writing, and press Esc to leave — and I am asked before unsaved words are thrown away.
 * ARCHITECTURE:
 *   - Pure functions only (no React, no DOM), so `AgentEditorDialog.tsx` stays a thin shell and the
 *     behaviour is unit-tested in `agent-editor-view.test.ts`.
 *   - `editorKeyIntent` maps a keydown to save / close / nothing. `trapTabIndex` decides where Tab
 *     moves focus inside the dialog. `unsavedCloseCopy` is the copy for the shared ConfirmDialog.
 *   - No persistence here: saving still goes through MonacoFile's files PUT and `commitSystem`.
 */
import type { ConfirmCopy } from '@core/kernel/lifecycle';

export type EditorKeyIntent = 'save' | 'close' | null;

type KeyLike = { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean };

/** Cmd+S (macOS) or Ctrl+S (elsewhere) saves; Esc asks to close. IME composition is ignored. */
export function editorKeyIntent(e: KeyLike): EditorKeyIntent {
  if (e.isComposing) return null;
  if (e.key === 'Escape' || e.key === 'Esc') return 'close';
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) return 'save';
  return null;
}

/** Elements Tab can reach inside the dialog (Monaco's input is a textarea, so it counts). */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Focus trap: given how many focusable elements the dialog has and which one is active
 * (-1 = focus is outside them), return the index Tab should move to, or null to let the
 * browser move focus normally. Wraps last → first and (Shift+Tab) first → last.
 */
export function trapTabIndex(count: number, active: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (active < 0) return shift ? count - 1 : 0;
  if (shift && active === 0) return count - 1;
  if (!shift && active === count - 1) return 0;
  return null;
}

/** The files with unsaved edits, from a path → dirty map, in a stable order. */
export function dirtyPaths(dirty: Record<string, boolean>): string[] {
  return Object.keys(dirty).filter((p) => dirty[p]).sort();
}

/** Dirty-map key for the role field (not a file, but guarded like one). */
export const ROLE_DRAFT_KEY = 'role';

/**
 * Single click vs double click on a canvas card. A single click opens the side drawer,
 * whose full-screen scrim would swallow the second click of a double-click. So the
 * single-click action waits `delayMs`; a double-click inside that window cancels it and
 * runs the double-click action instead. Timers are injectable for tests.
 */
export function createClickGate(
  delayMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  return {
    click(fn: () => void) {
      cancel();
      pending = timers.set(() => { pending = null; fn(); }, delayMs);
    },
    double(fn: () => void) {
      cancel();
      fn();
    },
    cancel,
  };
}

/**
 * Should a "the source changed" signal touch an open file? Only when the file's own
 * content in the source differs from what the editor last loaded or saved. Other edits
 * to system.yaml (tools, model, role) leave this file alone, with no false alarm.
 */
export function sourceChangeAction(source: string | undefined, loaded: string | null, dirty: boolean): 'none' | 'reload' | 'stale' {
  if (source === undefined || loaded === null || source === loaded) return 'none';
  return dirty ? 'stale' : 'reload';
}

/** Confirm copy shown when the user closes the editor with unsaved edits. */
export function unsavedCloseCopy(paths: string[]): ConfirmCopy {
  const names = paths.map((p) => (p === ROLE_DRAFT_KEY ? 'the role' : p.split('/').pop() ?? p));
  const list = names.length <= 1 ? names[0] ?? 'this file' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return {
    title: 'Discard unsaved changes?',
    body: `You have unsaved edits in ${list}. Close the editor and lose them? Press Cmd/Ctrl+S first to keep them.`,
    confirmLabel: 'Discard and close',
    danger: true,
  };
}
