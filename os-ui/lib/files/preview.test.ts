/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewText, PREVIEW_TEXT_LIMIT } from './preview.ts';

test('short text: no toggle, shown whole, not truncated', () => {
  const r = previewText('hello', false);
  assert.equal(r.canToggle, false);
  assert.equal(r.truncated, false);
  assert.equal(r.body, 'hello');
});

test('long text collapsed: truncated to the limit with the toggle available', () => {
  const long = 'x'.repeat(PREVIEW_TEXT_LIMIT + 500);
  const r = previewText(long, false);
  assert.equal(r.canToggle, true);
  assert.equal(r.truncated, true);
  assert.equal(r.body.length, PREVIEW_TEXT_LIMIT);
});

test('Show all expands long text to the FULL body (the toggle fix)', () => {
  const long = 'x'.repeat(PREVIEW_TEXT_LIMIT + 500);
  const collapsed = previewText(long, false);
  const expanded = previewText(long, true);
  // Toggling showAll must actually change what is shown — the whole body appears.
  assert.notEqual(expanded.body.length, collapsed.body.length);
  assert.equal(expanded.body, long);
  assert.equal(expanded.truncated, false);
  assert.equal(expanded.canToggle, true); // the Collapse affordance stays visible
});

test('text exactly at the limit does not toggle', () => {
  const exact = 'y'.repeat(PREVIEW_TEXT_LIMIT);
  const r = previewText(exact, false);
  assert.equal(r.canToggle, false);
  assert.equal(r.body, exact);
});
