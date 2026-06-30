/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOn, evaluateAlert, dueReports, sendReport, type ScheduledReport } from './alerts.ts';
import { measureFromForm } from '../metrics/model.ts';
import { goldSales } from '../metrics/fixtures.ts';

const measure = measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] });

test('alert is built on the canonical metric member', () => {
  const rule = alertOn(goldSales(), measure, { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email'] });
  assert.equal(rule.member, 'Sales.revenue');
});

test('breach notifies AND triggers a governed agent run (traced)', () => {
  const rule = alertOn(goldSales(), measure, {
    id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email', 'slack'],
    triggerAgent: { systemId: 'sales', agent: 'sales-agent', preset: 'recovery-note' },
  });
  const breached = evaluateAlert(rule, 42000);
  assert.ok(breached.breached);
  assert.equal(breached.notifications.length, 2);
  assert.ok(breached.agentRun);
  assert.equal(breached.agentRun?.traced, true);
  assert.match(breached.agentRun?.reason ?? '', /Sales.revenue = 42000 lt 50000/);

  const fine = evaluateAlert(rule, 60000);
  assert.equal(fine.breached, false);
  assert.equal(fine.agentRun, null);
  assert.equal(fine.notifications.length, 0);
});

test('scheduled report sends when its cadence has elapsed, then resets', () => {
  const now = 10_000_000_000_000;
  const reports: ScheduledReport[] = [
    { id: 'r-weekly', dashboardId: 'd1', cadence: 'weekly', channel: 'email', lastSentAt: now - 8 * 24 * 3600 * 1000 },
    { id: 'r-fresh', dashboardId: 'd1', cadence: 'weekly', channel: 'email', lastSentAt: now - 1 * 24 * 3600 * 1000 },
  ];
  const due = dueReports(reports, now);
  assert.deepEqual(due.map((r) => r.id), ['r-weekly']);
  const { report, send } = sendReport(due[0], now);
  assert.equal(report.lastSentAt, now);
  assert.equal(send.dashboardId, 'd1');
  assert.equal(dueReports([report], now).length, 0);
});
