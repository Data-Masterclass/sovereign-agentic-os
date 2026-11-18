/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    "Where the results go" never loses a typed output draft
 * USER STORY: As a team author I fill the output fields, leave the stage and come back — my work
 *             must be saved or I must have been asked, never silently discarded.
 * ARCHITECTURE:
 *   - Pure tests over `tabs/agents/lib/output-draft.ts` (the dirty/valid predicates).
 *   - Plus a SOURCE tripwire over `SimpleBuilder.tsx`: a test cannot import a `.tsx`
 *     (Node strips types but not JSX ⇒ ERR_UNKNOWN_FILE_EXTENSION), so the label and the
 *     guard wiring are pinned by reading the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_OUTPUT_DRAFT,
  outputDraftDirty,
  outputDraftValid,
  type OutputDraft,
} from '@tabs/agents/lib/output-draft';

const draft = (over: Partial<OutputDraft> = {}): OutputDraft => ({ ...EMPTY_OUTPUT_DRAFT, ...over });

test('OUTPUT-DRAFT: the empty draft is not dirty', () => {
  assert.equal(outputDraftDirty(EMPTY_OUTPUT_DRAFT), false);
  assert.equal(outputDraftDirty(draft()), false);
});

test('OUTPUT-DRAFT: ANY field differing from empty makes it dirty — the marker never under-reports', () => {
  assert.equal(outputDraftDirty(draft({ name: 'Weekly report' })), true, 'a typed name');
  assert.equal(outputDraftDirty(draft({ kind: 'data' })), true, 'a Type flip alone');
  assert.equal(outputDraftDirty(draft({ scope: 'domain' })), true, 'a Scope flip alone');
  assert.equal(outputDraftDirty(draft({ folder: '/reports' })), true, 'a chosen folder alone');
});

test('OUTPUT-DRAFT: whitespace-only text is not a change', () => {
  assert.equal(outputDraftDirty(draft({ name: '   ' })), false, 'spaces are not content');
  assert.equal(outputDraftDirty(draft({ folder: '  ' })), false, 'a blank folder is the empty root');
});

test('OUTPUT-DRAFT: valid needs a name AND a folder — root counts as a folder', () => {
  assert.equal(outputDraftValid(draft({ name: 'Weekly report' })), true, 'name + root folder');
  assert.equal(outputDraftValid(draft({ name: 'Weekly report', folder: '/reports' })), true);
  assert.equal(outputDraftValid(EMPTY_OUTPUT_DRAFT), false, 'nothing typed');
  assert.equal(outputDraftValid(draft({ name: '   ' })), false, 'a whitespace name is no name');
  assert.equal(outputDraftValid(draft({ name: 'Weekly report', folder: '   ' })), false, 'no folder');
});

test('OUTPUT-DRAFT: a dirty draft can be invalid — that is the case that must PROMPT', () => {
  const typeOnly = draft({ kind: 'knowledge' });
  assert.equal(outputDraftDirty(typeOnly), true);
  assert.equal(outputDraftValid(typeOnly), false);
});

test('OUTPUT-DRAFT-TRIPWIRE: the button no longer says "+ Add output", and the guard is wired', () => {
  // Read, never import: a test cannot import a .tsx.
  const src = readFileSync(join(process.cwd(), 'tabs/agents/ui/SimpleBuilder.tsx'), 'utf8');
  assert.ok(!src.includes('+ Add output'), 'the misleading "+ Add output" label is gone');
  assert.ok(src.includes('Save output'), 'the button says what it does: Save output');
  assert.match(src, /from '@tabs\/agents\/lib\/output-draft'/, 'the component uses the shared predicates');
  assert.match(src, /outputDraftDirty\(/, 'dirtiness drives the marker + the exit guard');
  assert.match(src, /outputDraftValid\(/, 'validity decides commit-on-exit vs prompt');
  assert.ok(src.includes('unsaved output'), 'the draft row carries a visible unsaved marker');
});
