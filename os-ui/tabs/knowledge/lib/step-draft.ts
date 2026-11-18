/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The step inspector's draft — compared the way the store actually keeps it
 * USER STORY: As a process owner I must see "• unsaved" clear when my save lands, not linger
 *             because the text I typed had a trailing space the store trimmed away.
 * ARCHITECTURE:
 *   - `setStepIO` trims each line and drops the blanks, `updateStep` trims the title and
 *     `serializeTacit` trims the note. Comparing a raw draft with the saved step therefore read
 *     "dirty" immediately after a successful commit. Normalise both sides first.
 *   - Pure + component-free, so the rule has a test; `StepInspector` imports it rather than
 *     re-deriving the comparison inline.
 */
import type { WorkflowStep } from '@tabs/knowledge/lib/schema';

/** The step inspector's editable fields, as the textareas hold them. */
export type StepDraft = {
  title: string;
  /** The `category::name` option value of the chosen registry actor ('' when unassigned). */
  actorValue: string;
  /** One entry per line. */
  inputs: string;
  outputs: string;
  tacit: string;
};

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

/** Normalise a draft the way the mutations store it, so a comparison means something. */
export function normaliseStepDraft(d: StepDraft): StepDraft {
  return {
    title: d.title.trim(),
    actorValue: d.actorValue.trim(),
    inputs: lines(d.inputs),
    outputs: lines(d.outputs),
    tacit: d.tacit.trim(),
  };
}

/** The saved baseline for a step: what the inspector shows before anything is typed. */
export function stepDraftFrom(step: WorkflowStep, actorValue: string): StepDraft {
  return {
    title: step.title,
    actorValue,
    inputs: step.inputs.join('\n'),
    outputs: step.outputs.join('\n'),
    tacit: step.tacit,
  };
}

/** True when the draft would actually change the stored step. */
export function stepDraftDirty(draft: StepDraft, saved: StepDraft): boolean {
  const a = normaliseStepDraft(draft);
  const b = normaliseStepDraft(saved);
  return a.title !== b.title
    || a.actorValue !== b.actorValue
    || a.inputs !== b.inputs
    || a.outputs !== b.outputs
    || a.tacit !== b.tacit;
}
