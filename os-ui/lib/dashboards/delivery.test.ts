/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setMailTransportForTests, type OutgoingMail } from '../mailer.ts';
import { __resetNotifications, listNotifications } from '../notifications/store.ts';
import { deliverAlert, deliverReport } from './delivery.ts';
import { evaluateAlert, type AlertRule } from '../metrics/alerts.ts';
import { type ScheduledReport } from './reports.ts';

const report: ScheduledReport = { id: 'r1', dashboardId: 'sales-overview', cadence: 'weekly', channel: 'email', lastSentAt: 0 };
const rule: AlertRule = { id: 'a1', member: 'Sales.revenue', comparator: 'lt', threshold: 50000, notify: ['email', 'slack'] };

afterEach(() => {
  __setMailTransportForTests(null);
  __resetNotifications();
});

test('report delivery emails the recipient when a mailer is configured', async () => {
  const sent: OutgoingMail[] = [];
  __setMailTransportForTests(async (m) => { sent.push(m); });

  const res = await deliverReport(report, { userId: 'amir', email: 'amir@example.com' }, Date.now());
  assert.equal(res.channel, 'email');
  assert.equal(res.delivered, true);
  assert.equal(res.to, 'amir@example.com');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'amir@example.com');
  assert.match(sent[0].subject, /sales-overview/);
  // nothing persisted to the in-app inbox when email succeeded
  assert.equal(listNotifications('amir').length, 0);
});

test('report delivery falls back to a persisted in-app notification when no mailer', async () => {
  // No transport override, no SMTP/GRAPH env ⇒ mailerConfigured() is false.
  const res = await deliverReport(report, { userId: 'amir', email: 'amir@example.com' }, Date.now());
  assert.equal(res.channel, 'in_app');
  assert.equal(res.delivered, true);
  assert.ok(res.notificationId);

  const inbox = listNotifications('amir');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'report');
  assert.match(inbox[0].title, /sales-overview/);
});

test('a fired alert delivers one notification per channel (in-app fallback)', async () => {
  const evald = evaluateAlert(rule, 42000); // breach
  assert.ok(evald.breached);

  const results = await deliverAlert(evald, rule.member, { userId: 'amir' });
  assert.equal(results.length, 2); // email + slack channels
  assert.ok(results.every((r) => r.delivered));

  const inbox = listNotifications('amir');
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every((n) => n.kind === 'alert'));
  assert.match(inbox[0].title, /Sales\.revenue/);
});

test('no breach ⇒ no delivery (nothing fires)', async () => {
  const fine = evaluateAlert(rule, 60000);
  const results = await deliverAlert(fine, rule.member, { userId: 'amir' });
  assert.equal(results.length, 0);
  assert.equal(listNotifications('amir').length, 0);
});

test('a fired alert emails when a mailer is configured', async () => {
  const sent: OutgoingMail[] = [];
  __setMailTransportForTests(async (m) => { sent.push(m); });

  const evald = evaluateAlert(rule, 42000);
  const results = await deliverAlert(evald, rule.member, { userId: 'amir', email: 'amir@example.com' });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.channel === 'email'));
  assert.equal(sent.length, 2);
  assert.equal(listNotifications('amir').length, 0);
});
