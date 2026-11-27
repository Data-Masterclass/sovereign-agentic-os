/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricAgentMessages, parseMetricProposal, MetricAgentError, asciiFoldName } from '@tabs/metrics/lib/agent';
import { measureName as slug } from '@tabs/metrics/lib/model';

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

test('metricAgentMessages: English leaves the prompt unchanged; another language asks for the name in it', () => {
  const en = metricAgentMessages(COLUMNS, 'revenue');
  assert.deepEqual(metricAgentMessages(COLUMNS, 'revenue', 'en'), en);
  const de = metricAgentMessages(COLUMNS, 'revenue', 'de');
  assert.match(de[0].content, /ANSWER LANGUAGE: German/);
  assert.ok(de[0].content.startsWith(en[0].content), 'the English prompt is kept, the instruction is appended');
  assert.equal(de[1].content, en[1].content, 'the user turn (columns, goal) is untouched');
  assert.match(de[0].content, /plain ASCII/, 'a translated name must stay a clean identifier');
  assert.match(de[0].content, /never translate it/, 'the aggregation keyword is never translated');
  assert.doesNotMatch(en[0].content, /plain ASCII/);
});

test('parseMetricProposal: an accented (de/pl/cs/fr) agent name is folded to ASCII, so the frozen measure name is a clean id', () => {
  const pl = parseMetricProposal(JSON.stringify({ name: 'Średnia wartość zamówień — łącznie', aggregation: 'avg', column: 'net_amount', dimensions: [] }), COLUMNS);
  assert.equal(pl.name, 'Srednia wartosc zamowien lacznie');
  assert.equal(slug(pl.name), 'srednia_wartosc_zamowien_lacznie');
  const cs = parseMetricProposal(JSON.stringify({ name: 'Průměrná tržba', aggregation: 'avg', column: 'net_amount', dimensions: [] }), COLUMNS);
  assert.equal(slug(cs.name), 'prumerna_trzba');
  const de = parseMetricProposal(JSON.stringify({ name: 'Größter Umsatz', aggregation: 'max', column: 'net_amount', dimensions: [] }), COLUMNS);
  assert.equal(de.name, 'Grosster Umsatz');
  assert.equal(asciiFoldName('Revenue by region'), 'Revenue by region', 'plain English names are unchanged');
  assert.equal(slug('Průměrná tržba'), 'pr_m_rn_tr_ba', 'the measure-name slug itself is unchanged for existing names');
});

test('parseMetricProposal: the aggregation must be one of the fixed keywords — tolerant of case, never guessed', () => {
  assert.equal(parseMetricProposal(JSON.stringify({ name: 'Umsatz', aggregation: ' SUM ', column: 'net_amount', dimensions: [] }), COLUMNS).aggregation, 'sum');
  for (const bad of ['Summe', 'suma', undefined]) {
    assert.throws(
      () => parseMetricProposal(JSON.stringify({ name: 'Umsatz', aggregation: bad, column: 'net_amount', dimensions: [] }), COLUMNS),
      (e: unknown) => e instanceof MetricAgentError && /unknown aggregation/.test((e as Error).message),
    );
  }
});
