/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exploreSpec, dropToSql, previewTrinoSql } from '@tabs/metrics/lib/explorer';
import { measureFromForm, type MetricForm } from '@tabs/metrics/lib/model';
import { goldSales } from '@tabs/metrics/lib/fixtures';

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };

test('exploreSpec qualifies the canonical member + slice against the view', () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['region'], timeDimension: 'order_date', granularity: 'month' });
  assert.equal(spec.member, 'Sales.revenue');
  assert.deepEqual(spec.dimensions, ['Sales.region']);
  assert.equal(spec.timeDimension, 'Sales.order_date');
  assert.equal(spec.granularity, 'month');
});

test('exploreSpec drops a slice on a non-view member (the PRIMARY KEY) — reported, never silent', () => {
  const d = goldSales();
  // order_id is the PK: a model dimension but NOT in the view → not servable on the view.
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['order_id', 'region'] });
  assert.deepEqual(spec.dimensions, ['Sales.region']); // PK scrubbed, real member kept
  assert.deepEqual(spec.dropped, ['order_id']);
});

test('exploreSpec drops a non-member timeDimension (fail-soft)', () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { timeDimension: 'order_id', granularity: 'month' });
  assert.equal(spec.timeDimension, undefined);
  assert.equal(spec.granularity, undefined);
});

test('dropToSql exposes the same governed member as a SQL table', () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['region'] });
  const sql = dropToSql(spec);
  assert.match(sql, /FROM "Sales"/);
  assert.match(sql, /"revenue"/);
  assert.match(sql, /"region"/);
});

test('drill-down filters compile to a WHERE over CAST(col AS varchar) — before GROUP BY', () => {
  const d = goldSales();
  const m = measureFromForm(FORM);
  const spec = exploreSpec(d, m, { dimensions: ['region'], filters: [{ column: 'region', values: ["DE", "O'Neil"] }] });
  const sql = previewTrinoSql(d, m, spec)!;
  assert.match(sql, /WHERE CAST\("region" AS varchar\) IN \('DE', 'O''Neil'\)/, 'quoted + escaped IN list');
  assert.ok(sql.indexOf('WHERE') < sql.indexOf('GROUP BY'), 'WHERE narrows rows BEFORE aggregation');
});

test('a filter on a non-view member is dropped LOUDLY (never a silently unnarrowed drill)', () => {
  const d = goldSales();
  const m = measureFromForm(FORM);
  const spec = exploreSpec(d, m, { filters: [{ column: 'order_id', values: ['1'] }] });
  assert.equal(spec.filters, undefined, 'the non-member filter is not in the query');
  assert.deepEqual(spec.dropped, ['order_id'], 'and it is REPORTED');
  const sql = previewTrinoSql(d, m, spec)!;
  assert.ok(!sql.includes('WHERE'), 'no partial filtering');
});
