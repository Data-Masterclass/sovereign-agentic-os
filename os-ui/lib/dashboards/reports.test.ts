/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceChannel, dueReports, sendReport, type ScheduledReport } from './reports.ts';

test('scheduled report sends when its cadence has elapsed, then resets', () => {
  const now = 10_000_000_000_000;
  const reports: ScheduledReport[] = [
    { id: 'r-weekly', dashboardId: 'd1', cadence: 'weekly', channel: 'in_app', lastSentAt: now - 8 * 24 * 3600 * 1000 },
    { id: 'r-fresh', dashboardId: 'd1', cadence: 'weekly', channel: 'in_app', lastSentAt: now - 1 * 24 * 3600 * 1000 },
  ];
  const due = dueReports(reports, now);
  assert.deepEqual(due.map((r) => r.id), ['r-weekly']);
  const { report, send } = sendReport(due[0], now);
  assert.equal(report.lastSentAt, now);
  assert.equal(send.dashboardId, 'd1');
  assert.equal(dueReports([report], now).length, 0);
});

test('a report with a legacy email/slack channel is coerced to in_app on send', () => {
  const now = 10_000_000_000_000;
  // A legacy config shape (bypassing the narrowed type) still delivers in-app.
  const legacy = { id: 'r-legacy', dashboardId: 'd1', cadence: 'weekly' as const, channel: 'email' as unknown as 'in_app', lastSentAt: 0 };
  const { report, send } = sendReport(legacy, now);
  assert.equal(report.channel, 'in_app');
  assert.equal(send.channel, 'in_app');
  assert.equal(coerceChannel('slack'), 'in_app');
});
