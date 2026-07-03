/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureFromForm, type MetricForm } from './model.ts';
import { metricRecord, governMetric, canPromote, canCertify } from './governance.ts';
import { goldSales } from './fixtures.ts';

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };
const resolve = async () => 42000;

function rec() {
  const d = goldSales();
  return metricRecord(d, measureFromForm(FORM), 'amir', 'personal');
}

test('Builder promotes Personal → Domain (consistency gate passes)', async () => {
  const r = await governMetric(rec(), 'promote', { id: 'bea', role: 'builder' }, resolve);
  assert.ok(r.ok, r.reason);
  assert.equal(r.record.tier, 'domain');
});

test('a non-Builder CANNOT promote (separation of duties, shared with data)', async () => {
  const r = await governMetric(rec(), 'promote', { id: 'amir', role: 'creator' }, resolve);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /Builder/);
});

test('Admin certifies Domain → Marketplace; a Builder cannot', async () => {
  const promoted = await governMetric(rec(), 'promote', { id: 'bea', role: 'builder' }, resolve);
  const certified = await governMetric(promoted.record, 'certify', { id: 'sara', role: 'admin' }, resolve);
  assert.ok(certified.ok, certified.reason);
  assert.equal(certified.record.tier, 'marketplace');
  const denied = await governMetric(promoted.record, 'certify', { id: 'bea', role: 'builder' }, resolve);
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? '', /Admin/);
});

test('promotion is blocked when the metric is inconsistent (does not resolve)', async () => {
  const r = await governMetric(rec(), 'promote', { id: 'bea', role: 'builder' }, async () => null);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /consistency/);
});

test('role predicates drive the UI buttons', () => {
  assert.equal(canPromote('creator'), false);
  assert.equal(canPromote('builder'), true);
  assert.equal(canCertify('builder'), false);
  assert.equal(canCertify('admin'), true);
});
