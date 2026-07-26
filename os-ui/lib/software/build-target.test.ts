/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_MODE, actionPrompt, targetKey, targetLabel, type TargetEpic } from './build-target.ts';

const EPICS: TargetEpic[] = [
  { id: 'e1', title: 'Invoices', stories: [{ id: 's1', title: 'List overdue' }, { id: 's2', title: 'Send reminder' }] },
  { id: 'e2', title: '', stories: [] },
];

// ------------------------------------------------------------ target labels ----

test('targetLabel: app / epic / story scopes derive honest labels', () => {
  assert.equal(targetLabel(EPICS, { kind: 'app' }), 'the whole app');
  assert.equal(targetLabel(EPICS, { kind: 'epic', epicId: 'e1' }), 'the EPIC “Invoices”');
  assert.equal(targetLabel(EPICS, { kind: 'story', epicId: 'e1', storyId: 's2' }), 'the story “Invoices › Send reminder”');
});

test('targetLabel: untitled + unknown nodes fall back, never crash', () => {
  assert.equal(targetLabel(EPICS, { kind: 'epic', epicId: 'e2' }), 'the EPIC “Untitled EPIC”');
  assert.equal(targetLabel(EPICS, { kind: 'epic', epicId: 'missing' }), 'the EPIC “Untitled EPIC”');
  assert.equal(targetLabel(EPICS, { kind: 'story', epicId: 'e1', storyId: 'missing' }), 'the story “Invoices › Untitled story”');
});

test('targetKey is stable + unique per node', () => {
  assert.equal(targetKey({ kind: 'app' }), 'app');
  assert.equal(targetKey({ kind: 'epic', epicId: 'e1' }), 'epic:e1');
  assert.equal(targetKey({ kind: 'story', epicId: 'e1', storyId: 's1' }), 'story:e1:s1');
});

// ------------------------------------------------------------ action → mode ----

test('ACTION_MODE: Design maps to Plan; only Build executes; Test/Review are their own modes', () => {
  assert.equal(ACTION_MODE.design, 'plan');
  assert.equal(ACTION_MODE.build, 'build');
  assert.equal(ACTION_MODE.test, 'test');
  assert.equal(ACTION_MODE.review, 'review');
});

// ------------------------------------------------------------ action prompts ---

test('actionPrompt: build scopes to the exact node (story / epic order / whole app)', () => {
  assert.match(actionPrompt('build', EPICS, { kind: 'story', epicId: 'e1', storyId: 's1' }), /Invoices › List overdue.*acceptance criteria/);
  assert.match(actionPrompt('build', EPICS, { kind: 'epic', epicId: 'e1' }), /stories in order/);
  assert.match(actionPrompt('build', EPICS, { kind: 'app' }), /whole app.*to-do stories in order/);
});

test('actionPrompt: design asks for refinement; test demands grounded PASS/FAIL; review asks for ideas', () => {
  assert.match(actionPrompt('design', EPICS, { kind: 'epic', epicId: 'e1' }), /Refine the design of the EPIC “Invoices”/);
  const t = actionPrompt('test', EPICS, { kind: 'app' });
  assert.match(t, /critical tester/);
  assert.match(t, /read the committed code/);
  assert.match(t, /PASS\/FAIL per story/);
  assert.match(t, /files you actually read/);
  const r = actionPrompt('review', EPICS, { kind: 'app' });
  assert.match(r, /file-by-file/);
  assert.match(r, /3-5 concrete improvement or feature ideas/);
});
