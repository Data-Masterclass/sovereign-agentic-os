/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrequentCron, nextCronRun, parseSimpleCron } from './sync-next-run.ts';

const at = (iso: string) => new Date(iso);

test('nextCronRun: */15 fires at the next quarter hour (UTC)', () => {
  assert.equal(nextCronRun('*/15 * * * *', at('2026-07-01T10:07:00Z'))?.toISOString(), '2026-07-01T10:15:00.000Z');
  assert.equal(nextCronRun('*/15 * * * *', at('2026-07-01T10:15:00Z'))?.toISOString(), '2026-07-01T10:30:00.000Z');
  assert.equal(nextCronRun('*/30 * * * *', at('2026-07-01T10:31:00Z'))?.toISOString(), '2026-07-01T11:00:00.000Z');
});

test('nextCronRun: hourly / daily cross their boundaries', () => {
  assert.equal(nextCronRun('0 * * * *', at('2026-07-01T10:07:00Z'))?.toISOString(), '2026-07-01T11:00:00.000Z');
  // Daily at 06:00 — already past today, so tomorrow.
  assert.equal(nextCronRun('0 6 * * *', at('2026-07-01T10:07:00Z'))?.toISOString(), '2026-07-02T06:00:00.000Z');
});

test('nextCronRun: weekly lands on the right weekday', () => {
  // 2026-07-01 is a Wednesday; next Monday 06:00 UTC is 2026-07-06.
  assert.equal(nextCronRun('0 6 * * 1', at('2026-07-01T10:07:00Z'))?.toISOString(), '2026-07-06T06:00:00.000Z');
});

test('nextCronRun: unsupported shapes are honestly null (never a guess)', () => {
  assert.equal(nextCronRun('0 6 1 * *', at('2026-07-01T00:00:00Z')), null); // restricted dom
  assert.equal(nextCronRun('0,30 * * * *', at('2026-07-01T00:00:00Z')), null); // list
  assert.equal(nextCronRun('not a cron', at('2026-07-01T00:00:00Z')), null);
  assert.equal(parseSimpleCron('*/70 * * * *'), null); // out-of-range step
});

test('isFrequentCron: ≤30-minute cadences flag, hourly+ do not', () => {
  assert.equal(isFrequentCron('*/15 * * * *'), true);
  assert.equal(isFrequentCron('*/30 * * * *'), true);
  assert.equal(isFrequentCron('* * * * *'), true);
  assert.equal(isFrequentCron('*/45 * * * *'), false);
  assert.equal(isFrequentCron('0 * * * *'), false);
  assert.equal(isFrequentCron('0 6 * * *'), false);
  assert.equal(isFrequentCron('garbage'), false);
});
