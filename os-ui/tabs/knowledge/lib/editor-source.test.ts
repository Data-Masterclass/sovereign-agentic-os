/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    Source tripwires for the workflow editor's two inspectors
 * USER STORY: As a process owner I must never see another step's text in the inspector, and an
 *             edit must only be saved when I press Save — so those facts need a test that holds.
 * ARCHITECTURE:
 *   - A test cannot import a `.tsx` under `node --test` (ARCHITECTURE.md), so the component facts
 *     that have no lib surface are pinned by reading the source — the same convention as
 *     `tabs/agents/lib/tool-catalog.test.ts` and `security-route-guards.test.ts`.
 *   - Each assertion names the defect it prevents: stale inspector text (unkeyed + defaultValue),
 *     blur-commits, inline actor-name editing, and the drop-if-busy commit guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

test('StepInspector is keyed by step id so switching steps cannot show stale text', () => {
  assert.match(read('tabs/knowledge/ui/WorkflowView.tsx'), /<StepInspector[\s\S]{0,400}key=\{step\.id\}/);
});

test('ActorInspector is keyed by actor id', () => {
  assert.match(read('tabs/knowledge/ui/WorkflowView.tsx'), /<ActorInspector[\s\S]{0,400}key=\{actor\.id/);
});

test('neither inspector has an uncontrolled defaultValue field left', () => {
  for (const f of ['tabs/knowledge/ui/StepInspector.tsx', 'tabs/knowledge/ui/ActorInspector.tsx']) {
    assert.ok(!read(f).includes('defaultValue='), `${f} must use controlled value={…} fields`);
  }
});

test('no inspector field commits on blur — an explicit Save button does', () => {
  for (const f of ['tabs/knowledge/ui/StepInspector.tsx', 'tabs/knowledge/ui/ActorInspector.tsx']) {
    const src = read(f);
    assert.ok(!src.includes('onBlur='), `${f} must not commit on blur`);
    assert.match(src, /onClick=\{\(\) => void save\(\)\}/, `${f} must offer an explicit Save button`);
    assert.match(src, /disabled=\{!dirty \|\| saving\}/, `${f}'s Save must be disabled when nothing changed`);
  }
});

test('both inspectors guard unsaved changes on close and show an inline error', () => {
  for (const f of ['tabs/knowledge/ui/StepInspector.tsx', 'tabs/knowledge/ui/ActorInspector.tsx']) {
    const src = read(f);
    assert.match(src, /unsaved/i, `${f} must show a dirty / unsaved marker`);
    assert.match(src, /Discard/i, `${f} must guard a close with unsaved changes`);
  }
});

test('ActorsPanel no longer edits the name inline — a row opens the inspector', () => {
  const src = read('tabs/knowledge/ui/ActorsPanel.tsx');
  assert.ok(!src.includes('ap-name-input'), 'the inline name input must be gone');
  assert.ok(!src.includes('defaultValue='), 'no uncontrolled row field may remain');
  assert.match(src, /onSelect/, 'a row must open the inspector');
});

test('WorkflowView commits through the never-dropping queue, not the drop-if-busy guard', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /createCommitQueue/);
  assert.ok(!src.includes('if (actingRef.current) return;'), 'the drop-if-busy guard must be gone');
});
