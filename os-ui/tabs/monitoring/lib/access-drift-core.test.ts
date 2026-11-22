/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: Trino's access rules were changed outside the OS
 * USER STORY: As a platform admin I am told when the access rules were edited by hand and repaired.
 * ARCHITECTURE: pure over `lastDrift()` of the rules reconciler; shown for 24 hours after it happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessDriftAlerts } from '@tabs/monitoring/lib/access-drift-core';

const NOW = Date.parse('2026-11-22T12:00:00Z');

test('a drift found in the last 24 hours is one warning for admins, with the repair stated', () => {
  const a = accessDriftAlerts({ at: NOW - 3_600_000, detail: 'The Trino access rules were changed outside the OS. The OS restored them.' }, NOW);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.equal(a[0].cluster, true);
  assert.match(a[0].detail, /restored/);
});

test('twin: no drift, or one older than 24 hours, raises nothing', () => {
  assert.deepEqual(accessDriftAlerts(null, NOW), []);
  assert.deepEqual(accessDriftAlerts({ at: NOW - 25 * 3_600_000, detail: 'x' }, NOW), []);
});
