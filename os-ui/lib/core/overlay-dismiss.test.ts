/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the overlay dismiss safety net — the invariant that any full-screen
 * overlay can ALWAYS be escaped (Escape key + backdrop click). Regression guard
 * for the stuck black embedded-tool overlay (os-ui 0.6.139).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEscapeKey, isBackdropClick, onEscape } from './overlay-dismiss.ts';

test('isEscapeKey matches Escape and the legacy Esc value', () => {
  assert.equal(isEscapeKey({ key: 'Escape' }), true);
  assert.equal(isEscapeKey({ key: 'Esc' }), true);
});

test('isEscapeKey ignores every other key (so typing never closes)', () => {
  for (const key of ['Enter', 'a', 'Tab', ' ', 'ArrowDown', '']) {
    assert.equal(isEscapeKey({ key }), false, `key ${JSON.stringify(key)} must not dismiss`);
  }
  assert.equal(isEscapeKey({}), false);
});

test('isBackdropClick is true only when the click landed on the backdrop itself', () => {
  const backdrop = { id: 'backdrop' };
  const card = { id: 'card' };
  // Clicked the scrim (target === currentTarget) → dismiss.
  assert.equal(isBackdropClick(backdrop, backdrop), true);
  // Clicked a child panel inside the backdrop → do NOT dismiss.
  assert.equal(isBackdropClick(card, backdrop), false);
});

test('isBackdropClick is false for null/undefined targets (never a phantom dismiss)', () => {
  assert.equal(isBackdropClick(null, null), false);
  assert.equal(isBackdropClick(undefined, undefined), false);
  assert.equal(isBackdropClick(null, { id: 'backdrop' }), false);
});

test('onEscape is SSR-safe — returns a no-op cleanup when there is no document', () => {
  // In the node test runner there is no global `document`; the helper must not throw.
  assert.equal(typeof globalThis.document, 'undefined');
  const cleanup = onEscape(() => { throw new Error('must not fire without a document'); });
  assert.equal(typeof cleanup, 'function');
  cleanup(); // must not throw
});
