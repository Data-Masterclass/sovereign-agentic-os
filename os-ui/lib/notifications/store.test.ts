/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { addNotification, listNotifications, markRead, unreadCount, __resetNotifications } from './store.ts';

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
