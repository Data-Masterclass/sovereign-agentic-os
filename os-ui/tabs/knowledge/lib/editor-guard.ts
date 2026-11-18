/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The workflow editor's unsaved-changes guard — every exit, not just the ✕
 * USER STORY: As a process owner I must be asked before a draft is discarded, whichever way I leave
 *             the inspector: another step, the same step again, another actor, or another panel.
 * ARCHITECTURE:
 *   - Pure state machine. `WorkflowView` owns the intents (it owns `selectedStep`,
 *     `selectedActor` and `panel`) and renders the prompt; the inspectors only report dirtiness.
 *     The guard previously lived inside the inspector, which never saw the parent change selection
 *     — and the inspector is keyed by step id, so the parent's change silently remounted it.
 *   - Two functions, no hidden state: ask before navigating, then resolve the user's choice.
 */

/** Where the editor is being asked to go. */
export type EditorIntent =
  | { kind: 'step'; stepId: string | null }
  | { kind: 'actor'; actorId: string | null }
  | { kind: 'panel'; panel: string };

/**
 * Everything in the editor that can hold unsaved text. The guard asks about ALL of
 * them, because each is an independent way to lose work: the open inspector's fields,
 * the Markdown panel's buffer (its own editor, its own Save), and the little add-a-link
 * / add-a-rule / new-actor forms, whose typed text is discarded on navigation.
 */
export type DirtySources = {
  inspector?: boolean;
  markdown?: boolean;
  subForms?: boolean;
};

/** True when anything in the editor holds unsaved text. */
export function editorDirty(sources: DirtySources): boolean {
  return Boolean(sources.inspector || sources.markdown || sources.subForms);
}

export type NavRequest =
  | { action: 'navigate'; intent: EditorIntent }
  | { action: 'prompt'; intent: EditorIntent };

/** What the user picked in the prompt. */
export type GuardChoice = 'save' | 'discard' | 'keep';

export type NavResolution =
  | { action: 'navigate'; intent: EditorIntent; saveFirst: boolean }
  | { action: 'stay' };

/** Navigate immediately when nothing is unsaved; otherwise ask first. */
export function requestNavigation(dirty: boolean, intent: EditorIntent): NavRequest {
  return dirty ? { action: 'prompt', intent } : { action: 'navigate', intent };
}

/** Turn the user's choice into the move to make. Nothing pending → nothing happens. */
export function resolveNavigation(choice: GuardChoice, pending: EditorIntent | null): NavResolution {
  if (!pending || choice === 'keep') return { action: 'stay' };
  return { action: 'navigate', intent: pending, saveFirst: choice === 'save' };
}
