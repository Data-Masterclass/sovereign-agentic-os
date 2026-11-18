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
    assert.match(src, /disabled=\{!(?:dirty|draftDirty) \|\| saving\}/, `${f}'s Save must be disabled when nothing changed`);
  }
});

test('both inspectors show a dirty marker and report dirtiness UP for the guard', () => {
  for (const f of ['tabs/knowledge/ui/StepInspector.tsx', 'tabs/knowledge/ui/ActorInspector.tsx']) {
    const src = read(f);
    assert.match(src, /unsaved/i, `${f} must show a dirty / unsaved marker`);
    assert.match(src, /onDirtyChange\(\{ dirty, save/, `${f} must report its draft state to the parent`);
  }
});

test('the unsaved-changes guard covers EVERY exit, not just the ✕', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /requestNavigation/, 'navigation must ask the guard first');
  assert.match(src, /resolveNavigation/, 'the prompt must resolve through the guard');
  assert.match(src, /Discard changes/, 'the prompt must offer Discard');
  // No selection or panel change may bypass `navigate(…)`.
  assert.ok(!/onClick=\{\(\) => setPanel\(/.test(src), 'a panel button must not call setPanel directly');
  assert.ok(!/onSelectStep=\{\(id\) => setSelectedStep\(/.test(src), 'the canvas must not select a step directly');
  assert.match(src, /onSelectStep=\{\(id\) => navigate\(/, 'the canvas selects through the guard');
  assert.match(src, /onSelect=\{\(id\) => navigate\(/, 'an actor row selects through the guard');
});

test('every commit is a reducer over the fresh document — no snapshot of the render', () => {
  const view = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(view, /mutate = useCallback\(\s*async \(reduce: WorkflowReducer\)/);
  assert.match(view, /setActErr\(''\)/, 'each queued commit clears the stale error banner');
  assert.match(read('tabs/knowledge/ui/commitWorkflow.ts'), /commitReducer/);
  for (const f of [
    'tabs/knowledge/ui/StepInspector.tsx',
    'tabs/knowledge/ui/ActorInspector.tsx',
    'tabs/knowledge/ui/ActorsPanel.tsx',
    'tabs/knowledge/ui/RulesPanel.tsx',
  ]) {
    const src = read(f);
    assert.match(src, /WorkflowReducer/, `${f} must commit through a reducer`);
    assert.ok(!/mutate\((?:add|remove|update|set|move)[A-Za-z]*\(workflow[,)]/.test(src),
      `${f} must not commit a document built from this render's workflow prop`);
  }
});

test('the row actions that fire mid-commit are disabled while a commit is in flight', () => {
  const src = read('tabs/knowledge/ui/StepInspector.tsx');
  // Each ✕ / toggle inside a list: link remove, rule remove, hard toggle.
  const guarded = src.match(/disabled=\{saving\}/g) ?? [];
  assert.ok(guarded.length >= 4, `expected the list actions to carry disabled={saving}, found ${guarded.length}`);
});

test('the Markdown buffer is guarded too, and a reload never clobbers it', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /editorDirty\(/, 'the guard must be asked about every unsaved source');
  assert.match(src, /markdown: mdDirtyRef\.current/, 'the Markdown buffer must feed the guard');
  assert.match(src, /saveMarkdownRef\.current\(\)/, 'Save & continue must be able to save the Markdown buffer');
  assert.match(src, /mdDraftRef\.current === mdBaseRef\.current/, 'reload must not overwrite an unsaved buffer');
});

test('"Remove step" stops reporting a draft for a step that no longer exists', () => {
  const src = read('tabs/knowledge/ui/StepInspector.tsx');
  // The remove path closes the inspector; reporting dirty afterwards would let the guard
  // try to "Save & continue" into a vanished step.
  assert.match(src, /discardDraft\(\);\s*\n?\s*onClose\(\);/, 'the remove path must discard the draft before closing');
  assert.match(src, /function discardDraft\(\)[\s\S]{0,200}onDirtyChange\(\{ dirty: false/);
});

test('the inspector reports typed-but-unadded sub-form text as unsaved', () => {
  const src = read('tabs/knowledge/ui/StepInspector.tsx');
  assert.match(src, /subFormDirty\(\[/, 'the sub-form buffers must be part of the dirtiness report');
  for (const buffer of ['newLinkRef', 'newRule', 'naName']) {
    assert.ok(new RegExp(`subFormDirty\\(\\[[\\s\\S]{0,200}${buffer}`).test(src), `${buffer} must be counted`);
  }
});

test('the commit queue is created lazily, not on every render', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /useRef<CommitQueue \| null>\(null\)/);
  assert.ok(!/useRef<CommitQueue>\(\s*createCommitQueue/.test(src), 'a queue must not be built inline on each render');
});

test('ActorsPanel no longer edits the name inline — a row opens the inspector', () => {
  const src = read('tabs/knowledge/ui/ActorsPanel.tsx');
  assert.ok(!src.includes('ap-name-input'), 'the inline name input must be gone');
  assert.ok(!src.includes('defaultValue='), 'no uncontrolled row field may remain');
  assert.match(src, /onSelect/, 'a row must open the inspector');
});

// ---- the Agent actor's long prompt, and the AGENT.md preview beside it ---------

test('the ActorInspector prompt field is controlled and part of the one Save', () => {
  const src = read('tabs/knowledge/ui/ActorInspector.tsx');
  assert.match(src, /value=\{prompt\}/, 'the prompt textarea must be controlled');
  assert.match(src, /setPrompt\(e\.target\.value\)/);
  assert.match(src, /prompt(\.trim\(\))? !== saved\.prompt/, 'the prompt must count towards `dirty`');
  assert.match(
    src,
    /updateActor\(fresh[\s\S]{0,120}prompt/,
    'the prompt must ride the SAME updateActor reducer — not a second commit',
  );
});

test('the AGENT.md preview is the scaffold’s own builder, not a second copy', () => {
  const src = read('tabs/knowledge/ui/ActorInspector.tsx');
  assert.match(src, /actorAgentMd/, 'the preview must call the shared builder');
  assert.match(src, /@tabs\/knowledge\/lib\/actor-prompt/);
});

test('no knowledge editor component pulls an Agents-tab module into the browser bundle', () => {
  for (const f of ['tabs/knowledge/ui/ActorInspector.tsx', 'tabs/knowledge/ui/HandoverPanel.tsx']) {
    assert.ok(!read(f).includes('@tabs/agents'), `${f} must import only @core/* and this tab`);
  }
});

test('WorkflowView commits through the never-dropping queue, not the drop-if-busy guard', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /createCommitQueue/);
  assert.ok(!src.includes('if (actingRef.current) return;'), 'the drop-if-busy guard must be gone');
});
