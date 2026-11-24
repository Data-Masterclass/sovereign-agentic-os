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
import { editorKeyIntent, trapTabIndex, dirtyPaths, unsavedCloseCopy, createClickGate, sourceChangeAction, ROLE_DRAFT_KEY } from '@tabs/agents/lib/agent-editor-view';

function fakeTimers() {
  let next = 1;
  const live = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => { const id = next++; live.set(id, fn); return id; },
      clear: (h: unknown) => { live.delete(h as number); },
    },
    flush: () => { const fns = [...live.values()]; live.clear(); fns.forEach((f) => f()); },
    pending: () => live.size,
  };
}

test('click gate: a lone click runs the single action after the delay', () => {
  const t = fakeTimers();
  const gate = createClickGate(300, t.timers);
  const log: string[] = [];
  gate.click(() => log.push('drawer'));
  assert.deepEqual(log, []);
  t.flush();
  assert.deepEqual(log, ['drawer']);
});

test('click gate: click, click, dblclick opens the large editor and never the drawer', () => {
  const t = fakeTimers();
  const gate = createClickGate(300, t.timers);
  const log: string[] = [];
  gate.click(() => log.push('drawer'));
  gate.click(() => log.push('drawer'));
  gate.double(() => log.push('large'));
  assert.equal(t.pending(), 0);
  t.flush();
  assert.deepEqual(log, ['large']);
});

test('click gate: cancel drops a pending single click', () => {
  const t = fakeTimers();
  const gate = createClickGate(300, t.timers);
  const log: string[] = [];
  gate.click(() => log.push('drawer'));
  gate.cancel();
  t.flush();
  assert.deepEqual(log, []);
});

test('source change: only a change to THIS file reloads or flags it', () => {
  assert.equal(sourceChangeAction('a', 'a', true), 'none', 'tools/model edit — same file content — no alarm');
  assert.equal(sourceChangeAction('b', 'a', false), 'reload');
  assert.equal(sourceChangeAction('b', 'a', true), 'stale');
  assert.equal(sourceChangeAction(undefined, 'a', true), 'none');
  assert.equal(sourceChangeAction('b', null, false), 'none', 'not loaded yet');
});

test('unsaved-close copy names an unsaved role draft', () => {
  assert.match(unsavedCloseCopy([ROLE_DRAFT_KEY]).body, /the role/);
});

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
