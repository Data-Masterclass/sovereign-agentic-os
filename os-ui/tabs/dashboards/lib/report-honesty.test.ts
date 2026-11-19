/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       dashboards
 * FEATURE:    The "scheduled report" panel says what it does: one in-app notice, no schedule
 * USER STORY: As a dashboard builder I want the report panel to tell me that "Post" adds a
 *             one-line notice to my in-app notifications and that scheduling is not available,
 *             so I never believe a weekly report is going out when nothing is saved or sent.
 * ARCHITECTURE:
 *   - No scheduler exists: nothing calls `dueReports`, and the cadence was component state
 *     that was never saved. The panel's words live in `report-copy.ts` (a `.tsx` cannot be
 *     imported by a test); this test reads that copy and the component's source.
 *   - `deliverReport` is run for real against the in-app notification store.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __resetNotifications, listNotifications } from '@core/notifications/store';
import { deliverReport } from '@tabs/dashboards/lib/delivery';

const reportsUi = () => readFileSync(join(process.cwd(), 'tabs/dashboards/ui/Reports.tsx'), 'utf8');

afterEach(() => __resetNotifications());

test('the panel offers no cadence control, because no cadence is saved or acted on', () => {
  const src = reportsUi();
  assert.doesNotMatch(src, /<select/, 'no cadence picker');
  assert.doesNotMatch(src, /delivered on a cadence/i);
});

test('the result line says it was posted to in-app notifications, not "✓ Sent"', async () => {
  const src = reportsUi();
  assert.doesNotMatch(src, /✓ Sent/);
  const { REPORT_COPY } = await import('@tabs/dashboards/lib/report-copy');
  assert.match(REPORT_COPY.posted, /Posted to your in-app notifications/);
  assert.match(REPORT_COPY.schedulingUnavailable, /Scheduling is not available yet/);
  assert.match(src, /REPORT_COPY\.posted/);
  assert.match(src, /REPORT_COPY\.schedulingUnavailable/);
});

test('the notice itself does not claim a snapshot or a cadence', async () => {
  await deliverReport({ dashboardId: 'sales-overview', cadence: 'weekly', channel: 'in_app' }, { userId: 'amir' }, Date.now());
  const [n] = listNotifications('amir');
  assert.ok(n, 'one notice was posted');
  assert.doesNotMatch(n.body, /snapshot/i, 'no snapshot is attached');
  assert.doesNotMatch(`${n.title} ${n.body}`, /weekly|scheduled/i, 'no schedule exists');
});
