/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeUsage, totalSpend } from './gateway-usage.ts';

test('totalSpend normalises the number / object / array / null shapes', () => {
  assert.equal(totalSpend(12.5), 12.5);
  assert.equal(totalSpend({ spend: 3.2 }), 3.2);
  assert.equal(totalSpend({ total_spend: 4 }), 4);
  assert.equal(totalSpend([{ spend: 1 }, { spend: 2 }, {}]), 3);
  assert.equal(totalSpend(null), 0);
  assert.equal(totalSpend(undefined), 0);
  // negatives / NaN are treated as 0 (never a bogus credit).
  assert.equal(totalSpend({ spend: -5 }), 0);
  assert.equal(totalSpend({ spend: Number('x') }), 0);
});

test('shapeUsage returns tenant totals + a clamped budget percentage', () => {
  const u = shapeUsage({
    activity: { sum_api_requests: 1200, sum_total_tokens: 3_400_000 },
    spend: { spend: 2.5 },
    budgetUsd: 5,
    budgetWindow: 'weekly',
  });
  assert.equal(u.requests, 1200);
  assert.equal(u.tokens, 3_400_000);
  assert.equal(u.spendUsd, 2.5);
  assert.equal(u.budgetUsd, 5);
  assert.equal(u.pctUsed, 50);
  assert.equal(u.budgetWindow, 'weekly');
});

test('shapeUsage clamps over-budget to 100 and rounds spend to cents', () => {
  const u = shapeUsage({
    activity: { sum_api_requests: 0, sum_total_tokens: 0 },
    spend: 8.129,
    budgetUsd: 5,
    budgetWindow: 'weekly',
  });
  assert.equal(u.pctUsed, 100, 'never exceeds 100%');
  assert.equal(u.spendUsd, 8.13, 'spend rounded to cents');
});

test('shapeUsage with no budget reports 0% (no divide-by-zero) and a default window', () => {
  const u = shapeUsage({
    activity: null,
    spend: null,
    budgetUsd: 0,
    budgetWindow: '',
  });
  assert.equal(u.requests, 0);
  assert.equal(u.tokens, 0);
  assert.equal(u.spendUsd, 0);
  assert.equal(u.budgetUsd, 0);
  assert.equal(u.pctUsed, 0);
  assert.equal(u.budgetWindow, 'weekly');
});
