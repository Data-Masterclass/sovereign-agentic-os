/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallToLine, committedSummaryLine, errorReason, buildStatusRail, buildOutcome } from './build-activity.ts';

test('commit maps to a file-count line from its files[] arg', () => {
  const l = toolCallToLine({
    tool: 'commit',
    args: { appId: 'a1', files: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    result: '{"ok":true}',
    isError: false,
  });
  assert.equal(l.text, 'Committed 2 files');
  assert.equal(l.isError, false);
});

test('commit with a single path counts one file', () => {
  const l = toolCallToLine({ tool: 'commit', args: { path: 'x.ts', content: '…' }, result: '', isError: false });
  assert.equal(l.text, 'Committed 1 file');
});

test('read_app_files with a path names the file; without, reads the tree', () => {
  assert.equal(toolCallToLine({ tool: 'read_app_files', args: { path: 'src/App.tsx' }, result: '', isError: false }).text, 'Read src/App.tsx');
  assert.equal(toolCallToLine({ tool: 'read_app_files', args: {}, result: '', isError: false }).text, 'Read the app files');
});

test('start_preview / request_deploy map to honest, plain lines', () => {
  assert.equal(toolCallToLine({ tool: 'start_preview', args: {}, result: '', isError: false }).text, 'Provisioning preview…');
  assert.match(
    toolCallToLine({ tool: 'request_deploy', args: {}, result: '', isError: false }).text,
    /Filed deploy review/,
  );
});

test('an errored step ALWAYS renders as a warning with the real reason, never a fake done', () => {
  const l = toolCallToLine({
    tool: 'commit',
    args: { appId: 'a1', files: [{ path: 'a.ts' }] },
    result: 'Error: forgejo unreachable',
    isError: true,
  });
  assert.equal(l.isError, true);
  assert.equal(l.text, '⚠ commit failed: forgejo unreachable');
  assert.doesNotMatch(l.text, /Committed/); // NOT a success line
});

test('an unknown tool falls back to a humanized "Ran <name>" line (never raw JSON)', () => {
  const l = toolCallToLine({ tool: 'some_new_tool', args: { big: 'blob' }, result: '{...}', isError: false });
  assert.equal(l.text, 'Ran some new tool');
  assert.doesNotMatch(l.text, /\{/);
});

test('errorReason strips the "Error:" prefix and caps length', () => {
  assert.equal(errorReason('Error: bad thing happened'), 'bad thing happened');
  assert.equal(errorReason(`${'x'.repeat(200)}`).length, 141); // 140 + ellipsis
});

test('committedSummaryLine reports net line delta from before/after', () => {
  const line = committedSummaryLine('MyApp', [
    { before: '', after: 'a\nb\nc' }, // +3
    { before: 'x\ny', after: 'x' }, // -1
  ]);
  assert.equal(line, 'Committed 2 files to MyApp (+3 −1)');
});

test('committedSummaryLine returns null for an empty changeset', () => {
  assert.equal(committedSummaryLine('MyApp', []), null);
});

test('buildStatusRail: fresh app reads Repo none · Preview none · Deploy none', () => {
  const rail = buildStatusRail({ pipeline: {}, repo: { seeded: [] }, deploy: { state: 'building', previewUrl: null, releases: 0 } });
  assert.deepEqual(rail.map((s) => `${s.label}:${s.value}`), ['Repo:none', 'Preview:none', 'Deploy:none']);
});

test('buildStatusRail: a committed repo + served preview + release reads all ok', () => {
  const rail = buildStatusRail({
    pipeline: { forgejo: 'ok' },
    repo: { seeded: ['a'] },
    deploy: { state: 'live', previewUrl: 'https://x', releases: 2 },
  });
  assert.deepEqual(rail.map((s) => `${s.label}:${s.value}:${s.tone}`), [
    'Repo:committed:ok',
    'Preview:live:ok',
    'Deploy:live:ok',
  ]);
});

test('buildStatusRail is HONEST: preview provisioning (state preview, NO url) is not "live"', () => {
  const rail = buildStatusRail({ pipeline: { forgejo: 'ok' }, repo: { seeded: ['a'] }, deploy: { state: 'preview', previewUrl: null, releases: 0 } });
  const preview = rail.find((s) => s.label === 'Preview')!;
  assert.equal(preview.value, 'provisioning');
  assert.equal(preview.tone, 'active');
});

test('buildStatusRail: a filed deploy review reads in-review (not live)', () => {
  const rail = buildStatusRail({ pipeline: { forgejo: 'ok' }, repo: { seeded: ['a'] }, deploy: { state: 'review', reviewCardId: 'c1', releases: 0 } });
  const dep = rail.find((s) => s.label === 'Deploy')!;
  assert.equal(dep.value, 'in-review');
  assert.equal(dep.tone, 'active');
});

test('buildOutcome: concrete files + net delta, null on empty', () => {
  assert.equal(buildOutcome([]), null);
  const out = buildOutcome([
    { path: 'src/App.tsx', before: 'a\nb', after: 'a\nb\nc\nd' }, // +2
    { path: 'src/os.ts', before: 'x\ny\nz', after: 'x' }, // -2
  ]);
  assert.equal(out!.fileCount, 2);
  assert.deepEqual(out!.files, ['src/App.tsx', 'src/os.ts']);
  assert.equal(out!.added, 2);
  assert.equal(out!.removed, 2);
  assert.equal(out!.headline, '2 files changed (+2 −2)');
});
