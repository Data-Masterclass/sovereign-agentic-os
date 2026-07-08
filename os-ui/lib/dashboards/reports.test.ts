/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReports, sendReport, type ScheduledReport } from './reports.ts';

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
