/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Tests for the large agent editor's keyboard, focus-trap and unsaved-changes rules
 * USER STORY: As a builder I trust Cmd/Ctrl+S to save, Esc to ask before discarding, and Tab to
 *             stay inside the open editor.
 * ARCHITECTURE:
 *   - Pure unit tests of `agent-editor-view.ts` (node:test, no DOM).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorKeyIntent, trapTabIndex, dirtyPaths, unsavedCloseCopy } from '@tabs/agents/lib/agent-editor-view';

test('Cmd+S and Ctrl+S save; plain s, Alt or Shift variants do not', () => {
  assert.equal(editorKeyIntent({ key: 's', metaKey: true }), 'save');
  assert.equal(editorKeyIntent({ key: 's', ctrlKey: true }), 'save');
  assert.equal(editorKeyIntent({ key: 'S', ctrlKey: true }), 'save');
  assert.equal(editorKeyIntent({ key: 's' }), null);
  assert.equal(editorKeyIntent({ key: 's', metaKey: true, shiftKey: true }), null);
  assert.equal(editorKeyIntent({ key: 's', ctrlKey: true, altKey: true }), null);
});

test('Esc asks to close; other keys and IME composition do nothing', () => {
  assert.equal(editorKeyIntent({ key: 'Escape' }), 'close');
  assert.equal(editorKeyIntent({ key: 'Esc' }), 'close');
  assert.equal(editorKeyIntent({ key: 'Enter' }), null);
  assert.equal(editorKeyIntent({ key: 'Escape', isComposing: true }), null);
});

test('focus trap wraps at both ends and pulls stray focus back in', () => {
  assert.equal(trapTabIndex(4, 3, false), 0);
  assert.equal(trapTabIndex(4, 0, true), 3);
  assert.equal(trapTabIndex(4, 1, false), null);
  assert.equal(trapTabIndex(4, 2, true), null);
  assert.equal(trapTabIndex(4, -1, false), 0);
  assert.equal(trapTabIndex(4, -1, true), 3);
  assert.equal(trapTabIndex(0, -1, false), null);
});

test('dirtyPaths lists only files with unsaved edits, sorted', () => {
  assert.deepEqual(dirtyPaths({ 'agents/a/MEMORY.md': true, 'agents/a/AGENT.md': true, x: false }), ['agents/a/AGENT.md', 'agents/a/MEMORY.md']);
  assert.deepEqual(dirtyPaths({}), []);
});

test('unsaved-close copy names the files and is a danger confirm', () => {
  const one = unsavedCloseCopy(['agents/a/AGENT.md']);
  assert.match(one.body, /AGENT\.md/);
  assert.equal(one.danger, true);
  const two = unsavedCloseCopy(['agents/a/AGENT.md', 'agents/a/MEMORY.md']);
  assert.match(two.body, /AGENT\.md and MEMORY\.md/);
});
