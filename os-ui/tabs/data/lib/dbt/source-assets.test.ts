/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the freshness window a sync's cron implies
 * USER STORY: As a reviewer I want proof that the window is two schedule intervals for every cron
 *             shape the OS schedule picker produces, and no claim for any other shape.
 * ARCHITECTURE: Pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronIntervalMinutes, freshnessMinutesFor } from '@tabs/data/lib/dbt/source-assets';

test('cronIntervalMinutes covers the shapes the OS schedule picker produces, and only those', () => {
  assert.equal(cronIntervalMinutes('*/15 * * * *'), 15);
  assert.equal(cronIntervalMinutes('*/5 * * * *'), 5);
  assert.equal(cronIntervalMinutes('0 * * * *'), 60);
  assert.equal(cronIntervalMinutes('30 */4 * * *'), 240);
  assert.equal(cronIntervalMinutes('0 6 * * *'), 1440);
  assert.equal(cronIntervalMinutes('0 6 * * 1'), 10080);
  // Richer expressions: no claim rather than a wrong one.
  assert.equal(cronIntervalMinutes('0 6 1 * *'), null);
  assert.equal(cronIntervalMinutes('H/5 * * * *'), null);
  assert.equal(cronIntervalMinutes('0 6 * *'), null);
  assert.equal(cronIntervalMinutes('*/0 * * * *'), null);
  assert.equal(freshnessMinutesFor('*/15 * * * *'), 30, 'two intervals of tolerance');
  assert.equal(freshnessMinutesFor('0 6 1 * *'), null);
});
