/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the Stories view's drafts and PUT bodies
 * USER STORY: As a business user I want what I type in the story form to be saved exactly: one Given/When/Then per line,
 *             empty lines ignored, and a new criterion sent without an id so the OS assigns it.
 * ARCHITECTURE: Pure tests over model.ts (the .ts sibling of the view components); the server re-validates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoryDoc } from '@tabs/software/lib/app-builder-contracts';
import { diffLines, emptyCriterion, epicBody, epicDraftOf, groupByEpic, LIGHT_BADGE, newStoryDraft, storyBody, storyDraftOf } from './model.ts';

const story: StoryDoc = {
  id: 'US-3',
  epic: 'EP-1',
  title: 'Submit',
  asA: 'rep',
  iWant: 'to submit',
  soThat: 'it ships',
  state: 'agreed',
  criteria: [{ id: 'AC-1', title: 'ok', given: ['a', 'b'], when: ['c'], then: ['d'] }],
  notes: 'n',
  path: 'stories/EP-1/US-3.md',
};

test('a story draft round-trips into the same story body; lines split, blanks dropped, new criteria without id', () => {
  const d = storyDraftOf(story);
  assert.equal(d.criteria[0].given, 'a\nb');
  d.criteria.push({ ...emptyCriterion(), title: ' new ', given: 'x\n\n  y  \n', when: 'w', then: 't' });
  const body = storyBody(d, 'f'.repeat(40));
  assert.equal(body.op, 'saveStory');
  assert.equal(body.story.id, 'US-3');
  assert.equal(body.story.baseSha, 'f'.repeat(40));
  assert.deepEqual(body.story.criteria, [
    { id: 'AC-1', title: 'ok', given: ['a', 'b'], when: ['c'], then: ['d'] },
    { title: 'new', given: ['x', 'y'], when: ['w'], then: ['t'] },
  ]);
  const fresh = storyBody(newStoryDraft('EP-2'), '');
  assert.equal('id' in fresh.story, false);
  assert.equal('baseSha' in fresh.story, false);
  assert.equal(fresh.story.state, 'draft');
});

test('epic body, grouping, light badges and diff line kinds', () => {
  const e = { id: 'EP-1' as const, title: 'Orders', description: 'd', requirements: { technical: 't', ux: '', governance: 'g' }, path: 'stories/EP-1/_epic.md' };
  assert.deepEqual(epicBody(epicDraftOf(e), '').epic, { id: 'EP-1', title: 'Orders', description: 'd', requirements: { technical: 't', ux: '', governance: 'g' } });
  const groups = groupByEpic({ epics: [e], stories: [{ ...story, status: 'agreed', light: 'partial' }] });
  assert.equal(groups[0].stories[0].id, 'US-3');
  assert.equal(LIGHT_BADGE.partial, 'badge warn');
  assert.deepEqual(diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n').map((l) => l.kind), ['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
});
