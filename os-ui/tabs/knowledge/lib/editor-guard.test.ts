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
import {
  requestNavigation,
  resolveNavigation,
  editorDirty,
  type EditorIntent,
} from '@tabs/knowledge/lib/editor-guard';

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

test('every unsaved source dirties the editor — the inspector, the Markdown buffer, a sub-form', () => {
  assert.equal(editorDirty({}), false);
  assert.equal(editorDirty({ inspector: false, markdown: false, subForms: false }), false);
  assert.equal(editorDirty({ inspector: true }), true);
  assert.equal(editorDirty({ markdown: true }), true, 'the Markdown panel is an exit too');
  assert.equal(editorDirty({ subForms: true }), true, 'typed-but-unadded sub-form text counts');
});

test('an unsaved Markdown buffer alone is enough to prompt before leaving the panel', () => {
  const dirty = editorDirty({ inspector: false, markdown: true, subForms: false });
  assert.deepEqual(requestNavigation(dirty, toPanel), { action: 'prompt', intent: toPanel });
});

test('a resolution with nothing pending stays put (a stray click cannot navigate)', () => {
  for (const choice of ['save', 'discard', 'keep'] as const) {
    assert.deepEqual(resolveNavigation(choice, null), { action: 'stay' });
  }
});
