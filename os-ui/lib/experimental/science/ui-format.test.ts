/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phraseMetric, rowToFeatures, phraseVerdict, usageToSeries, bandKeys, bandLabel } from './ui-format.ts';
import type { ModelUsage } from './types.ts';

test('phraseMetric: auc → ranked-positives sentence', () => {
  assert.equal(
    phraseMetric('auc', 0.871),
    'On held-back data the model ranked positives above negatives 87% of the time.',
  );
});

test('phraseMetric: rmse → typical error sentence', () => {
  assert.equal(phraseMetric('rmse', 12.3), 'Typical prediction error: ±12.3.');
  assert.equal(phraseMetric('rmse', 250.7), 'Typical prediction error: ±251.');
});

test('phraseMetric: absent value → null (never fabricate)', () => {
  assert.equal(phraseMetric('auc', undefined), null);
  assert.equal(phraseMetric(undefined, NaN), null);
});

test('phraseMetric: unknown metric → honest fallback', () => {
  assert.equal(phraseMetric('f1', 0.5), 'f1 0.5.');
});

test('rowToFeatures: maps by column order, coerces non-numeric to 0', () => {
  const columns = ['id', 'recency_days', 'name', 'monetary_value'];
  const row = ['42', '12', 'Acme', '999.5'];
  const { vector, display } = rowToFeatures(columns, row, ['recency_days', 'monetary_value', 'name']);
  assert.deepEqual(vector, { recency_days: 12, monetary_value: 999.5, name: 0 });
  assert.deepEqual(display, { recency_days: '12', monetary_value: '999.5', name: 'Acme' });
});

test('rowToFeatures: a feature not in the columns → 0 / empty display', () => {
  const { vector, display } = rowToFeatures(['a'], ['1'], ['missing']);
  assert.equal(vector.missing, 0);
  assert.equal(display.missing, '');
});

test('phraseVerdict: high band → headline + interpretation', () => {
  const v = phraseVerdict(0.82, 'high');
  assert.equal(v?.headline, 'High — 82%');
  assert.match(v!.detail, /probability, not a certainty/);
});

test('phraseVerdict: absent score → null', () => {
  assert.equal(phraseVerdict(undefined, 'high'), null);
});

test('bandKeys / bandLabel: decile buckets', () => {
  assert.deepEqual(bandKeys('decile'), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']);
  assert.equal(bandLabel('decile', 'd8'), '0.8–0.9');
  assert.equal(bandLabel('value-band', 'b3'), 'band 3');
});

test('usageToSeries: sums allowed scored calls per band across days', () => {
  const usage: ModelUsage = {
    count: 5,
    denied: 1,
    bandKind: 'decile',
    buckets: {
      '2026-08-01': { d8: 2, d2: 1 },
      '2026-08-02': { d8: 1 },
    },
  };
  const s = usageToSeries(usage);
  assert.deepEqual(s.days, ['2026-08-01', '2026-08-02']);
  assert.equal(s.scored, 4);
  assert.equal(s.totalsByBand[8], 3); // d8
  assert.equal(s.totalsByBand[2], 1); // d2
});

test('usageToSeries: no scored calls → empty (honest empty state)', () => {
  assert.equal(usageToSeries(undefined).scored, 0);
  assert.equal(usageToSeries({ count: 3, denied: 3, bandKind: 'decile', buckets: {} }).scored, 0);
});
