/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recurrenceToCron,
  cronToRecurrence,
  describeRecurrence,
  type Recurrence,
} from './cron-friendly.ts';
import { isValidCron } from './schedule-cron.ts';

test('recurrenceToCron — daily / weekly / monthly shapes', () => {
  assert.equal(recurrenceToCron({ frequency: 'daily', hour: 9, minute: 0 }), '0 9 * * *');
  assert.equal(
    recurrenceToCron({ frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1] }),
    '0 9 * * 1',
  );
  assert.equal(
    recurrenceToCron({ frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 1 }),
    '0 9 1 * *',
  );
});

test('recurrenceToCron — weekly days are sorted + deduped', () => {
  assert.equal(
    recurrenceToCron({ frequency: 'weekly', hour: 14, minute: 30, daysOfWeek: [5, 1, 3, 1] }),
    '30 14 * * 1,3,5',
  );
});

test('recurrenceToCron — weekly with no days defaults to Monday; monthly clamps to day 1', () => {
  assert.equal(recurrenceToCron({ frequency: 'weekly', hour: 8, minute: 0, daysOfWeek: [] }), '0 8 * * 1');
  assert.equal(recurrenceToCron({ frequency: 'monthly', hour: 8, minute: 0 }), '0 8 1 * *');
});

test('every generated cron is a valid 5-field cron', () => {
  const samples: Recurrence[] = [
    { frequency: 'daily', hour: 0, minute: 0 },
    { frequency: 'weekly', hour: 23, minute: 59, daysOfWeek: [0, 6] },
    { frequency: 'monthly', hour: 6, minute: 15, dayOfMonth: 31 },
  ];
  for (const r of samples) assert.ok(isValidCron(recurrenceToCron(r)), `invalid: ${recurrenceToCron(r)}`);
});

test('round-trip recurrence → cron → recurrence', () => {
  const cases: Recurrence[] = [
    { frequency: 'daily', hour: 9, minute: 0 },
    { frequency: 'daily', hour: 0, minute: 5 },
    { frequency: 'weekly', hour: 14, minute: 30, daysOfWeek: [1, 3, 5] },
    { frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1] },
    { frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 1 },
    { frequency: 'monthly', hour: 22, minute: 45, dayOfMonth: 15 },
  ];
  for (const r of cases) {
    const back = cronToRecurrence(recurrenceToCron(r));
    assert.deepEqual(back, r, `round-trip failed for ${JSON.stringify(r)}`);
  }
});

test('cronToRecurrence — parses the default Monday-09:00 cron', () => {
  assert.deepEqual(cronToRecurrence('0 9 * * 1'), {
    frequency: 'weekly',
    hour: 9,
    minute: 0,
    daysOfWeek: [1],
  });
});

test('cronToRecurrence — null fallback for patterns we do not model', () => {
  const complex = [
    '*/15 * * * *',      // step in minute
    '0 9-17 * * *',      // range in hour
    '0 9 * * 1-5',       // range in day-of-week
    '0 9,17 * * *',      // list of hours
    '0 9 1,15 * *',      // list of days-of-month
    '0 9 * JAN *',       // named month / non-wildcard month
    '0 9 1 * 1',         // both dom AND dow constrained
    '0 9 * * MON',       // named day
    'not a cron',        // invalid
    '0 25 * * *',        // hour out of range
    '61 9 * * *',        // minute out of range
    '0 9 32 * *',        // day-of-month out of range
    '0 9 * * 7',         // day-of-week out of range (we accept 0-6)
  ];
  for (const c of complex) assert.equal(cronToRecurrence(c), null, `expected null for: ${c}`);
});

test('describeRecurrence — plain-language summaries', () => {
  assert.equal(describeRecurrence({ frequency: 'daily', hour: 9, minute: 0 }), 'Daily at 09:00');
  assert.equal(
    describeRecurrence({ frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1] }),
    'Every Monday at 09:00',
  );
  assert.equal(
    describeRecurrence({ frequency: 'weekly', hour: 14, minute: 30, daysOfWeek: [1, 3, 5] }),
    'Every Mon, Wed, Fri at 14:30',
  );
  assert.equal(
    describeRecurrence({ frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 1 }),
    'Monthly on day 1 at 09:00',
  );
  assert.equal(
    describeRecurrence({ frequency: 'weekly', hour: 6, minute: 0, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }),
    'Every day at 06:00',
  );
});
