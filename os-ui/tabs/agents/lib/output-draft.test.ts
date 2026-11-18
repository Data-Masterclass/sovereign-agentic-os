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
  outputDraftFolder,
  outputDraftStorageKey,
  serializeOutputDraft,
  parseOutputDraft,
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

test('OUTPUT-DRAFT: valid needs a NAME; blank folder text means root, exactly as the commit reads it', () => {
  assert.equal(outputDraftValid(draft({ name: 'Weekly report' })), true, 'name + root folder');
  assert.equal(outputDraftValid(draft({ name: 'Weekly report', folder: '/reports' })), true);
  assert.equal(EMPTY_OUTPUT_DRAFT.folder, '/', 'the empty draft already sits at root');
  assert.equal(
    outputDraftValid(draft({ name: 'Weekly report', folder: '   ' })),
    true,
    'blank folder text is the ROOT, not a missing field — `addOutput` normalises it the same way',
  );
  assert.equal(outputDraftFolder(draft({ name: 'x', folder: '   ' })), '/', 'and that is what gets committed');
  assert.equal(outputDraftValid(EMPTY_OUTPUT_DRAFT), false, 'nothing typed');
  assert.equal(outputDraftValid(draft({ name: '   ' })), false, 'a whitespace name is no name');
});

test('OUTPUT-DRAFT: a parked draft round-trips, per system id', () => {
  const d = draft({ name: 'Weekly report', kind: 'data', scope: 'domain', folder: '/reports' });
  assert.deepEqual(parseOutputDraft(serializeOutputDraft(d)), d);
  assert.notEqual(
    outputDraftStorageKey('sys_a'),
    outputDraftStorageKey('sys_b'),
    'two teams park two drafts',
  );
});

test('OUTPUT-DRAFT: parsing never throws and trusts nothing', () => {
  assert.equal(parseOutputDraft(null), null, 'nothing parked');
  assert.equal(parseOutputDraft(''), null, 'empty string');
  assert.equal(parseOutputDraft('not json'), null, 'garbage');
  assert.equal(parseOutputDraft('[1,2,3]'), null, 'wrong shape');
  assert.equal(parseOutputDraft('{}'), null, 'an empty object holds nothing to restore');
  assert.equal(
    parseOutputDraft(serializeOutputDraft(EMPTY_OUTPUT_DRAFT)),
    null,
    'a clean draft is not a restore',
  );
  const odd = parseOutputDraft('{"kind":"spreadsheet","scope":"galaxy","name":"R","folder":5}');
  assert.deepEqual(
    odd,
    { kind: 'files', name: 'R', scope: 'personal', folder: '/' },
    'unrecognised enums and wrong types fall back to the empty draft’s values',
  );
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
  // M5: the stage guard cannot see the exits it does not own (sidebar, another tab, a reload),
  // so the draft is parked per system and restored on remount.
  assert.match(src, /outputDraftStorageKey\(/, 'the draft is parked per system id');
  assert.match(src, /parseOutputDraft\(/, 'and restored on remount');
  // M4: the prompt's Save button reads VALIDITY from state, not from a ref — a ref does not
  // re-render, so the button could never become enabled.
  assert.match(
    src,
    /useState<\{ dirty: boolean; valid: boolean \}>/,
    'dirty/valid are mirrored into state for the prompt to render against',
  );
});
