/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    "• unsaved" tells the truth — the draft is compared the way the mutations store it
 * USER STORY: As a process owner I must see the unsaved marker clear when my save lands, not sit
 *             there for ever because my text had a trailing space the store trimmed away.
 * ARCHITECTURE:
 *   - `setStepIO` trims and drops blank lines, `updateStep` trims the title, `serializeTacit` trims
 *     the note. A raw draft-vs-step comparison therefore reported "dirty" straight after a
 *     successful save. The draft is normalised the SAME way before comparing.
 *   - Pure helper so the rule is testable without the component.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '@tabs/knowledge/lib/schema';
import { stepDraftFrom, stepDraftDirty, normaliseStepDraft } from '@tabs/knowledge/lib/step-draft';

const WF = parseWorkflow(`---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - id: a-officer
    name: Loan Officer
    category: Human
---

\`\`\`step
id: one
title: One
actor: Human
actor_name: Loan Officer
inputs:
  - A
  - B
outputs:
  - C
\`\`\`

> tacit: Watch the date field.
`);

const step = WF.steps[0];
const saved = stepDraftFrom(step, 'Human::Loan Officer');

test('an untouched draft is not dirty', () => {
  assert.equal(stepDraftDirty(saved, saved), false);
});

test('trailing spaces, blank lines and a trailing newline are NOT a change', () => {
  const draft = {
    ...saved,
    title: '  One  ',
    inputs: 'A\n\nB\n',
    outputs: ' C \n',
    tacit: 'Watch the date field.\n\n',
  };
  assert.equal(stepDraftDirty(draft, saved), false, 'the store trims these away, so they are not edits');
});

test('a changed expert-knowledge note IS dirty', () => {
  assert.equal(stepDraftDirty({ ...saved, tacit: 'Watch the date field. And the IBAN.' }, saved), true);
});

test('a reordered or added input IS dirty', () => {
  assert.equal(stepDraftDirty({ ...saved, inputs: 'B\nA' }, saved), true);
  assert.equal(stepDraftDirty({ ...saved, inputs: 'A\nB\nC' }, saved), true);
});

test('picking another actor IS dirty', () => {
  assert.equal(stepDraftDirty({ ...saved, actorValue: 'Software::BankPortal' }, saved), true);
});

test('normaliseStepDraft is idempotent (normalising twice changes nothing)', () => {
  const once = normaliseStepDraft({ ...saved, inputs: ' A \n\n B \n' });
  assert.deepEqual(normaliseStepDraft(once), once);
});
