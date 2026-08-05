/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asChatRunMode, isReadOnlyMode, modeDirective, modelRoleForMode, tierNote, READ_ONLY_MODE_TOOLS, BUILD_PRINCIPLES, CODE_STRUCTURE_CONVENTION, DATA_PLANE_CONTRACT } from './chat-modes.ts';

test('tier policy: plan (Design) / test / review run on reasoning; build codegen on standard', () => {
  assert.equal(modelRoleForMode('plan'), 'reasoning');
  assert.equal(modelRoleForMode('test'), 'reasoning');
  assert.equal(modelRoleForMode('review'), 'reasoning');
  // The actual code generation is NEVER escalated — standard does the bulk writing.
  assert.equal(modelRoleForMode('build'), 'standard');
});

test('tier note is an honest label', () => {
  assert.equal(tierNote('reasoning'), 'reasoning model');
  assert.equal(tierNote('standard'), 'standard model');
});

test('asChatRunMode: valid modes pass through; anything else defaults to build', () => {
  for (const m of ['plan', 'build', 'test', 'review'] as const) assert.equal(asChatRunMode(m), m);
  assert.equal(asChatRunMode(undefined), 'build');
  assert.equal(asChatRunMode('deploy'), 'build');
  assert.equal(asChatRunMode(42), 'build');
});

test('isReadOnlyMode: every mode except build is read-only (harness-enforced)', () => {
  assert.equal(isReadOnlyMode('build'), false);
  assert.equal(isReadOnlyMode('plan'), true);
  assert.equal(isReadOnlyMode('test'), true);
  assert.equal(isReadOnlyMode('review'), true);
});

test('READ_ONLY_MODE_TOOLS: no write/mutating tool in the allowlist', () => {
  for (const t of READ_ONLY_MODE_TOOLS) {
    assert.ok(!/commit|preview|deploy|create|delete|promote/i.test(t), `${t} is read-only`);
  }
  assert.ok(READ_ONLY_MODE_TOOLS.includes('read_app_files'), 'test/review can ground themselves in the real files');
});

test('modeDirective: each mode gets its own honest directive; build names the appId', () => {
  assert.match(modeDirective('plan', 'app_1').join('\n'), /PLAN.*read-only/s);
  assert.match(modeDirective('build', 'app_1').join('\n'), /appId \(app_1\)/);
  const t = modeDirective('test', 'app_1').join('\n');
  assert.match(t, /verifier/i);
  assert.match(t, /NEVER fabricate test execution/);
  assert.match(t, /read_app_files/);
  const r = modeDirective('review', 'app_1').join('\n');
  assert.match(r, /file-by-file/);
  assert.match(r, /never invent functionality/);
});

// --------------------------------------------------------- BUILD_PRINCIPLES --

test('BUILD_PRINCIPLES: exactly five one-line principles, one per Test dimension', () => {
  const lines = BUILD_PRINCIPLES.split('\n');
  assert.equal(lines.length, 5, 'exactly five principles');
  for (const l of lines) assert.ok(!l.includes('\n') && l.trim().length > 0, 'each is one non-empty line');
  // 1:1 with the five Test dimensions.
  assert.match(BUILD_PRINCIPLES, /Functionality/);
  assert.match(BUILD_PRINCIPLES, /User Experience/);
  assert.match(BUILD_PRINCIPLES, /Code Structure/);
  assert.match(BUILD_PRINCIPLES, /Security/);
  assert.match(BUILD_PRINCIPLES, /Documentation/);
});

// --------------------------------------------- data-plane contract (write SDK) --

test('DATA_PLANE_CONTRACT: names the TRUE write surface (os.records.*) and forbids the hallucinations', () => {
  // The one real write door.
  assert.match(DATA_PLANE_CONTRACT, /os\.records\.add\(record\)/);
  assert.match(DATA_PLANE_CONTRACT, /os\.records\.export\(\)/);
  // Datasets/metrics/knowledge/files are READS.
  assert.match(DATA_PLANE_CONTRACT, /datasets are READ-ONLY/);
  // The hallucinated methods are explicitly ruled out.
  assert.match(DATA_PLANE_CONTRACT, /NO os\.datasets\.update/);
  assert.match(DATA_PLANE_CONTRACT, /no\s*\n?\s*os\.files\.create|os\.files\.create/);
  // The exact import-depth contract from a story folder.
  assert.match(DATA_PLANE_CONTRACT, /import \{ os \} from '\.\.\/\.\.\/\.\.\/core\/store'/);
  // The multi-file gate rule.
  assert.match(DATA_PLANE_CONTRACT, /fix EVERY listed file/);
  // Envelope-gated writes are called out.
  assert.match(DATA_PLANE_CONTRACT, /APPROVED deploy envelope/);
});

test('modeDirective(build): carries the data-plane contract (the write SDK)', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /os\.records\.add/);
  assert.match(b, /NO os\.datasets\.update/);
});

// --------------------------------------------- code-structure convention --

test('CODE_STRUCTURE_CONVENTION: names template/core/epics + thin app entrypoints', () => {
  assert.match(CODE_STRUCTURE_CONVENTION, /template\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /core\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /epics\/<epicKey>\/<storyKey>\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /epics\/<epicKey>\/general\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /THIN entrypoints/i);
  assert.match(CODE_STRUCTURE_CONVENTION, /governed data plane/i);
});

// --------------------------------------- BUILD directive injects both --

test('modeDirective(build): injects BUILD_PRINCIPLES + the code-structure convention', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.ok(b.includes(BUILD_PRINCIPLES), 'build prompt carries the five build principles');
  assert.ok(b.includes(CODE_STRUCTURE_CONVENTION), 'build prompt carries the structure convention');
  assert.match(b, /epics\/<epic>\/<story>/, 'tells the model where story code goes');
});

test('modeDirective(build): carries the EXACT commit signature + worked example', () => {
  // Hardening for the file-less-commit failure: the model must see the exact shape and
  // that code goes in `files`, not prose. A terse worked example rides every build turn.
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /commit\(\{ files: \[\{ path:/, 'the exact commit({ files: [{ path, content }] }) template is present');
  assert.match(b, /NOT in your prose/i, 'tells the model the source goes in files, not prose');
  assert.match(b, /BUILT[\s\S]*SUCCESSFUL commit/i, 'built-ness is earned by a real commit, not a claim');
});

test('modeDirective(build): forbids ending a failed build with an instructions essay', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /do NOT write a step-by-step.*essay|essay/i, 'forbids the plan-essay wrap-up');
  assert.match(b, /honestly marked failed|marked failed/i, 'a turn that cannot commit is marked failed, not disguised');
});

// ------------------------------------ PLAN (Design draft) injects principles --

test('modeDirective(plan): the Design drafting prompt carries the build principles', () => {
  const p = modeDirective('plan', 'app_1').join('\n');
  assert.ok(p.includes(BUILD_PRINCIPLES), 'design drafts against the same principles it builds by');
});

// --------------------------------- TEST = true 5-dimension verification --

test('modeDirective(test): verifies across the five named dimensions with per-dim PASS/FAIL', () => {
  const t = modeDirective('test', 'app_1').join('\n');
  for (const dim of ['Functionality', 'User Experience', 'Code Structure', 'Security', 'Documentation']) {
    assert.match(t, new RegExp(dim), `checks ${dim}`);
  }
  assert.match(t, /PASS\/FAIL/i, 'reports PASS/FAIL per dimension');
  assert.match(t, /epics → stories → features → NFRs → rules/, 'verifies the full spec hierarchy');
  assert.match(t, /TAGGED with its\s+dimension/, 'each shortfall is tagged with its dimension');
  assert.match(t, /functionality \| ux \| code \| security \| docs/, 'names the dimension tags');
  assert.match(t, /CITE the/, 'findings cite real files');
});
