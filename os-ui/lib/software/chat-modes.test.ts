/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asChatRunMode, isReadOnlyMode, modeDirective, READ_ONLY_MODE_TOOLS } from './chat-modes.ts';

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
  assert.match(t, /critical tester/);
  assert.match(t, /NEVER fabricate test execution/);
  assert.match(t, /read_app_files/);
  const r = modeDirective('review', 'app_1').join('\n');
  assert.match(r, /file-by-file/);
  assert.match(r, /never invent functionality/);
});
