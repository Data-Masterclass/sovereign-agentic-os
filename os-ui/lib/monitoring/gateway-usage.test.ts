/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeActivity, weeklyRunSpend, SPEND_WINDOW_MS } from './gateway-usage.ts';

// ---------------------------------------------------------------- activity ---

test('shapeActivity returns tenant totals from top-level sums', () => {
  const a = shapeActivity({ sum_api_requests: 1200, sum_total_tokens: 3_400_000 });
  assert.equal(a.requests, 1200);
  assert.equal(a.tokens, 3_400_000);
});

test('shapeActivity sums the daily_data rollup when top-level sum_* are absent', () => {
  const a = shapeActivity({
    daily_data: [
      { api_requests: 196, total_tokens: 28_327 },
      { api_requests: 67, total_tokens: 44_143 },
      { api_requests: 138, total_tokens: 886_166 },
    ],
  });
  assert.equal(a.requests, 401);
  assert.equal(a.tokens, 958_636);
});

test('shapeActivity prefers top-level sum_* over the daily rollup when present', () => {
  const a = shapeActivity({
    sum_api_requests: 10,
    sum_total_tokens: 20,
    daily_data: [{ api_requests: 999, total_tokens: 999 }],
  });
  assert.equal(a.requests, 10);
  assert.equal(a.tokens, 20);
});

test('shapeActivity normalises null / malformed input to zeros', () => {
  assert.deepEqual(shapeActivity(null), { requests: 0, tokens: 0 });
  assert.deepEqual(shapeActivity(undefined), { requests: 0, tokens: 0 });
  // Negatives / NaN are treated as 0 (never a bogus credit).
  assert.deepEqual(
    shapeActivity({ sum_api_requests: -5, sum_total_tokens: Number('x') }),
    { requests: 0, tokens: 0 },
  );
});

// ------------------------------------------------------------ weekly spend ---

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);

test('weeklyRunSpend sums priced runs to EUR cents (same costUsd values Monitoring shows)', () => {
  const w = weeklyRunSpend(
    [
      { at: NOW - 1_000, costUsd: 0.104, tokens: 1000 },
      { at: NOW - 2_000, costUsd: 0.021, tokens: 500 },
    ],
    NOW,
  );
  assert.equal(w.runs, 2);
  assert.equal(w.pricedRuns, 2);
  assert.equal(w.tokens, 1500);
  assert.equal(w.spendEur, 0.13, 'sum rounded to cents');
});

test('weeklyRunSpend: runs but nothing priced → spendEur null (unpriced ≠ €0)', () => {
  const w = weeklyRunSpend(
    [
      { at: NOW - 1_000, tokens: 900 },
      { at: NOW - 2_000, tokens: 100 },
    ],
    NOW,
  );
  assert.equal(w.runs, 2);
  assert.equal(w.pricedRuns, 0);
  assert.equal(w.tokens, 1000);
  assert.equal(w.spendEur, null, 'never fabricates €0 for unpriced runs');
});

test('weeklyRunSpend: mixed priced/unpriced counts both, sums only the priced', () => {
  const w = weeklyRunSpend(
    [
      { at: NOW - 1_000, costUsd: 0.5, tokens: 100 },
      { at: NOW - 2_000, tokens: 100 }, // unpriced — counted, not summed
    ],
    NOW,
  );
  assert.equal(w.runs, 2);
  assert.equal(w.pricedRuns, 1);
  assert.equal(w.spendEur, 0.5);
});

test('weeklyRunSpend: no runs at all → a true €0.00', () => {
  const w = weeklyRunSpend([], NOW);
  assert.equal(w.runs, 0);
  assert.equal(w.spendEur, 0, 'nothing ran ⇒ nothing spent — an honest zero');
});

test('weeklyRunSpend enforces the 7-day window boundaries', () => {
  const w = weeklyRunSpend(
    [
      { at: NOW - SPEND_WINDOW_MS, costUsd: 1 }, // exactly 7 days old — included
      { at: NOW - SPEND_WINDOW_MS - 1, costUsd: 100 }, // older — excluded
      { at: NOW, costUsd: 2 }, // right now — included
      { at: NOW + 1, costUsd: 100 }, // future timestamp — excluded
      { at: Number.NaN, costUsd: 100 }, // malformed — excluded
    ],
    NOW,
  );
  assert.equal(w.runs, 2);
  assert.equal(w.spendEur, 3);
});

test('weeklyRunSpend keeps a real €0-priced run as priced (free ≠ unpriced)', () => {
  const w = weeklyRunSpend([{ at: NOW - 1_000, costUsd: 0, tokens: 50 }], NOW);
  assert.equal(w.pricedRuns, 1);
  assert.equal(w.spendEur, 0, 'an explicitly free model is an honest €0.00');
});
