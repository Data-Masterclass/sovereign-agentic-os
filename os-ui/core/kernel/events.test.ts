/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the kernel event bus (B3-review-H-2)
 * USER STORY: As a reviewer I want proof that the bus delivers to every subscriber, unsubscribes,
 *             and cannot be taken down by one broken listener — because a user WRITE emits on it
 *             and a write must never fail because a consumer did.
 * ARCHITECTURE: Pure and synchronous. The directory-write → reconciler half of H-2 is tested in
 *   `tabs/admin/lib/directory-events.test.ts`, which lives on the TAB side: a test under `core/`
 *   may not import a tab (`scripts/check-structure.mjs` CORE-INDEPENDENCE).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitDirectoryChange, onDirectoryChange, onKernelEvent, emitKernelEvent, _resetKernelEvents } from '@core/kernel/events';

test('the bus delivers, unsubscribes, and survives a broken listener', () => {
  _resetKernelEvents();
  const seen: string[] = [];
  const off = onDirectoryChange((r) => seen.push(r));
  onDirectoryChange(() => {
    throw new Error('this listener is broken');
  });
  const other: string[] = [];
  onKernelEvent('directory-changed', (r) => other.push(r));

  emitDirectoryChange('user amir');
  assert.deepEqual(seen, ['user amir']);
  assert.deepEqual(other, ['user amir'], 'a throwing listener must not stop the next one');

  off();
  emitKernelEvent('directory-changed', 'domain sales');
  assert.deepEqual(seen, ['user amir'], 'unsubscribed');
  assert.deepEqual(other, ['user amir', 'domain sales']);
  _resetKernelEvents();
});
