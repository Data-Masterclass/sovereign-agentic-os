/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The unsaved-changes guard covers every way out of an inspector
 * USER STORY: As a process owner typing expert knowledge I must be asked before my draft is thrown
 *             away — whether I click another step, the same step again, or another panel.
 * ARCHITECTURE:
 *   - The guard used to live on the ✕ alone, so selecting another step, deselecting, or switching
 *     panel discarded the draft in silence (the inspector is keyed by step id, so it remounts).
 *   - Decision logic is a pure state machine here; `WorkflowView` owns the intents and the prompt,
 *     the inspectors only report dirtiness. That split is what makes the rule testable at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestNavigation, resolveNavigation, type EditorIntent } from '@tabs/knowledge/lib/editor-guard';

const toStep: EditorIntent = { kind: 'step', stepId: 'two' };
const deselect: EditorIntent = { kind: 'step', stepId: null };
const toPanel: EditorIntent = { kind: 'panel', panel: 'markdown' };
const toActor: EditorIntent = { kind: 'actor', actorId: 'a-portal' };

test('a clean inspector navigates straight away', () => {
  for (const intent of [toStep, deselect, toPanel, toActor]) {
    assert.deepEqual(requestNavigation(false, intent), { action: 'navigate', intent });
  }
});

test('a dirty inspector prompts instead — for another step, the same step again, a panel or an actor', () => {
  for (const intent of [toStep, deselect, toPanel, toActor]) {
    assert.deepEqual(requestNavigation(true, intent), { action: 'prompt', intent });
  }
});

test('Save & continue navigates after saving', () => {
  assert.deepEqual(resolveNavigation('save', toStep), { action: 'navigate', intent: toStep, saveFirst: true });
});

test('Discard navigates without saving', () => {
  assert.deepEqual(resolveNavigation('discard', toPanel), { action: 'navigate', intent: toPanel, saveFirst: false });
});

test('Keep editing stays put', () => {
  assert.deepEqual(resolveNavigation('keep', toStep), { action: 'stay' });
});

test('a resolution with nothing pending stays put (a stray click cannot navigate)', () => {
  for (const choice of ['save', 'discard', 'keep'] as const) {
    assert.deepEqual(resolveNavigation(choice, null), { action: 'stay' });
  }
});
