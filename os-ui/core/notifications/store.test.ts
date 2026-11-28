/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { addNotification, listNotifications, markRead, unreadCount, __resetNotifications } from '@core/notifications/store';

afterEach(() => { __resetNotifications(); });

test('a new notification starts unread and counts toward the badge', () => {
  addNotification({ userId: 'amir', kind: 'alert', title: 'Alert fired', body: 'Sales.revenue low' });
  assert.equal(unreadCount('amir'), 1);
  assert.equal(listNotifications('amir')[0].read, false);
});

test('markRead(user) clears ALL of that user\'s unread and returns the count changed', () => {
  addNotification({ userId: 'amir', kind: 'alert', title: 'A', body: '' });
  addNotification({ userId: 'amir', kind: 'report', title: 'B', body: '' });
  assert.equal(unreadCount('amir'), 2);

  const changed = markRead('amir');
  assert.equal(changed, 2);
  assert.equal(unreadCount('amir'), 0);
  assert.ok(listNotifications('amir').every((n) => n.read));

  // Idempotent: nothing left to change.
  assert.equal(markRead('amir'), 0);
});

test('markRead only touches the caller\'s own inbox', () => {
  addNotification({ userId: 'amir', kind: 'alert', title: 'A', body: '' });
  addNotification({ userId: 'bea', kind: 'alert', title: 'B', body: '' });

  markRead('amir');
  assert.equal(unreadCount('amir'), 0);
  assert.equal(unreadCount('bea'), 1, "bea's inbox is untouched");
});

test('markRead(user, ids) marks only the given subset', () => {
  const a = addNotification({ userId: 'amir', kind: 'alert', title: 'A', body: '' });
  addNotification({ userId: 'amir', kind: 'report', title: 'B', body: '' });

  const changed = markRead('amir', [a.id]);
  assert.equal(changed, 1);
  assert.equal(unreadCount('amir'), 1);
});

test('two processes adding a notification in the same millisecond never mint the same id', async () => {
  // Two module instances = two processes (os-ui and os-ui-worker): each has its own counter, and
  // both start at 0. With the clock frozen, only a random part keeps their ids apart — and a
  // shared id would make one mirrored notification overwrite the other.
  const a = await import(new URL('./store.ts?process=web', import.meta.url).href);
  const b = await import(new URL('./store.ts?process=worker', import.meta.url).href);
  const realNow = Date.now;
  Date.now = () => 1_795_000_000_000;
  try {
    const one = a.addNotification({ userId: 'amir', kind: 'alert', title: 'From os-ui', body: '' });
    const two = b.addNotification({ userId: 'amir', kind: 'alert', title: 'From the worker', body: '' });
    assert.notEqual(one.id, two.id);
  } finally {
    Date.now = realNow;
  }
});

test('two notifications in the same millisecond still list newest first', () => {
  mock.method(Date, 'now', () => 1_764_000_000_000);
  try {
    addNotification({ userId: 'u', kind: 'alert', title: 'first', body: '' });
    addNotification({ userId: 'u', kind: 'alert', title: 'second', body: '' });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(listNotifications('u').map((n) => n.title), ['second', 'first']);
});
