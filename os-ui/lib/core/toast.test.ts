/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushToast,
  dismissToast,
  resolveDuration,
  DEFAULT_DURATION,
  ACTION_DURATION,
  MAX_TOASTS,
  type Toast,
} from './toast.ts';

test('pushToast appends a toast with tone, message and resolved duration', () => {
  const q = pushToast([], { message: 'Added to your team' }, 100, 'a');
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'a');
  assert.equal(q[0].tone, 'success'); // default tone
  assert.equal(q[0].message, 'Added to your team');
  assert.equal(q[0].duration, DEFAULT_DURATION.success);
  assert.equal(q[0].createdAt, 100);
});

test('pushToast dedups an identical newest toast (double-click guard)', () => {
  let q = pushToast([], { tone: 'success', message: 'Saved' }, 1, 'a');
  q = pushToast(q, { tone: 'success', message: 'Saved' }, 2, 'b');
  assert.equal(q.length, 1, 'identical newest toast is not stacked twice');
  assert.equal(q[0].id, 'a');
});

test('pushToast does NOT dedup when tone or message differs', () => {
  let q = pushToast([], { tone: 'success', message: 'Saved' }, 1, 'a');
  q = pushToast(q, { tone: 'error', message: 'Saved' }, 2, 'b');
  q = pushToast(q, { tone: 'success', message: 'Deleted' }, 3, 'c');
  assert.equal(q.length, 3);
});

test('pushToast caps the queue at MAX_TOASTS, dropping the oldest', () => {
  let q: Toast[] = [];
  for (let i = 0; i < MAX_TOASTS + 3; i++) {
    q = pushToast(q, { message: `msg-${i}` }, i, `id-${i}`);
  }
  assert.equal(q.length, MAX_TOASTS);
  // oldest dropped: first surviving is msg-3 when MAX=4 and we pushed 7
  assert.equal(q[0].message, `msg-${MAX_TOASTS + 3 - MAX_TOASTS}`);
  assert.equal(q[q.length - 1].message, `msg-${MAX_TOASTS + 2}`);
});

test('dismissToast removes only the matching id', () => {
  let q = pushToast([], { message: 'one' }, 1, 'a');
  q = pushToast(q, { message: 'two' }, 2, 'b');
  q = dismissToast(q, 'a');
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'b');
});

test('dismissToast on a missing id is a no-op', () => {
  const q = pushToast([], { message: 'one' }, 1, 'a');
  assert.deepEqual(dismissToast(q, 'zzz'), q);
});

test('a toast carrying actions is kept (not deduped) and lingers for ACTION_DURATION', () => {
  const actions = [{ label: 'Go to Policies & Approvals →', href: '/governance' }];
  let q = pushToast([], { tone: 'info', message: 'Request filed', actions }, 1, 'a');
  // Same message+tone again — but WITH actions it is a distinct interactive prompt,
  // so it is NOT deduped away.
  q = pushToast(q, { tone: 'info', message: 'Request filed', actions }, 2, 'b');
  assert.equal(q.length, 2);
  assert.deepEqual(q[0].actions, actions);
  assert.equal(q[0].duration, ACTION_DURATION);
});

test('resolveDuration: an actioned toast defaults to ACTION_DURATION', () => {
  assert.equal(
    resolveDuration({ message: 'x', actions: [{ label: 'Approve now' }] }),
    ACTION_DURATION,
  );
  // An explicit duration still wins over the action default.
  assert.equal(
    resolveDuration({ message: 'x', actions: [{ label: 'Approve now' }], duration: 500 }),
    500,
  );
});

test('resolveDuration: explicit wins, else per-tone default, 0 stays sticky', () => {
  assert.equal(resolveDuration({ message: 'x' }), DEFAULT_DURATION.success);
  assert.equal(resolveDuration({ tone: 'error', message: 'x' }), DEFAULT_DURATION.error);
  assert.equal(resolveDuration({ message: 'x', duration: 1234 }), 1234);
  assert.equal(resolveDuration({ message: 'x', duration: 0 }), 0);
  assert.equal(resolveDuration({ message: 'x', duration: -5 }), 0);
});
