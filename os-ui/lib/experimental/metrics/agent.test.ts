/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricAgentMessages, parseMetricProposal, MetricAgentError } from './agent.ts';

const COLUMNS = ['net_amount', 'region', 'order_date', 'status'];

test('metricAgentMessages grounds the prompt in the real columns', () => {
  const msgs = metricAgentMessages(COLUMNS, 'total net revenue by region');
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /net_amount/);
  assert.match(msgs[1].content, /total net revenue by region/);
});

test('parseMetricProposal accepts a valid proposal and keeps only real columns', () => {
  const raw = JSON.stringify({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region', 'order_date'] });
  const form = parseMetricProposal(raw, COLUMNS);
  assert.equal(form.name, 'Revenue');
  assert.equal(form.aggregation, 'sum');
  assert.equal(form.column, 'net_amount');
  assert.deepEqual(form.dimensions, ['region', 'order_date']);
});

test('parseMetricProposal tolerates ```json fences and drops invented columns', () => {
  const raw = '```json\n{"name":"R","aggregation":"sum","column":"net_amount","dimensions":["ghost","region"]}\n```';
  const form = parseMetricProposal(raw, COLUMNS);
  assert.deepEqual(form.dimensions, ['region']); // "ghost" is not a real column → dropped
});

test('parseMetricProposal leaves column empty for count', () => {
  const form = parseMetricProposal(JSON.stringify({ name: 'Orders', aggregation: 'count', column: '', dimensions: ['status'] }), COLUMNS);
  assert.equal(form.column, '');
  assert.deepEqual(form.dimensions, ['status']);
});

test('parseMetricProposal rejects a non-count with no valid column (honest error)', () => {
  assert.throws(
    () => parseMetricProposal(JSON.stringify({ name: 'x', aggregation: 'sum', column: 'not_a_column', dimensions: [] }), COLUMNS),
    (e: unknown) => e instanceof MetricAgentError,
  );
});

test('parseMetricProposal rejects unparseable output (honest error, never fabricated)', () => {
  assert.throws(() => parseMetricProposal('the model rambled with no json', COLUMNS), (e: unknown) => e instanceof MetricAgentError);
});
