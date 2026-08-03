/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setMailTransportForTests, type OutgoingMail } from '../infra/mailer.ts';
import { __resetNotifications, listNotifications } from '../notifications/store.ts';
import { deliverAlert, deliverReport } from './delivery.ts';
import { evaluateAlert, type AlertRule } from '../metrics/alerts.ts';
import { type ScheduledReport } from './reports.ts';

const report: ScheduledReport = { id: 'r1', dashboardId: 'sales-overview', cadence: 'weekly', channel: 'in_app', lastSentAt: 0 };
const rule: AlertRule = { id: 'a1', member: 'Sales.revenue', comparator: 'lt', threshold: 50000, notify: ['in_app'] };

afterEach(() => {
  __setMailTransportForTests(null);
  __resetNotifications();
});

test('report delivery persists an in-app notification (never emails)', async () => {
  // Even with a mailer configured, reports deliver in-app only (the one delivery surface).
  const sent: OutgoingMail[] = [];
  __setMailTransportForTests(async (m) => { sent.push(m); });

  const res = await deliverReport(report, { userId: 'amir', email: 'amir@example.com' }, Date.now());
  assert.equal(res.channel, 'in_app');
  assert.equal(res.delivered, true);
  assert.equal(res.to, 'amir');
  assert.ok(res.notificationId);
  assert.equal(sent.length, 0, 'no email is ever sent');

  const inbox = listNotifications('amir');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'report');
  assert.match(inbox[0].title, /sales-overview/);
});

test('a fired alert delivers exactly one in-app notification', async () => {
  const evald = evaluateAlert(rule, 42000); // breach
  assert.ok(evald.breached);

  const results = await deliverAlert(evald, rule.member, { userId: 'amir' });
  assert.equal(results.length, 1); // in-app only
  assert.ok(results.every((r) => r.delivered && r.channel === 'in_app'));

  const inbox = listNotifications('amir');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'alert');
  assert.match(inbox[0].title, /Sales\.revenue/);
});

test('no breach ⇒ no delivery (nothing fires)', async () => {
  const fine = evaluateAlert(rule, 60000);
  const results = await deliverAlert(fine, rule.member, { userId: 'amir' });
  assert.equal(results.length, 0);
  assert.equal(listNotifications('amir').length, 0);
});

test('a fired alert never emails, even when a mailer is configured', async () => {
  const sent: OutgoingMail[] = [];
  __setMailTransportForTests(async (m) => { sent.push(m); });

  const evald = evaluateAlert(rule, 42000);
  const results = await deliverAlert(evald, rule.member, { userId: 'amir', email: 'amir@example.com' });
  assert.equal(results.length, 1);
  assert.ok(results.every((r) => r.channel === 'in_app'));
  assert.equal(sent.length, 0, 'no email is ever sent for an alert');
  assert.equal(listNotifications('amir').length, 1);
});
