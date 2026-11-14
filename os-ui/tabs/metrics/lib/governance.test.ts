/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureFromForm, type MetricForm } from '@tabs/metrics/lib/model';
import { metricRecord, governMetric, canPromote, canCertify } from '@tabs/metrics/lib/governance';
import { goldSales } from '@tabs/metrics/lib/fixtures';

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };
const resolve = async () => 42000;

/** `goldSales()` is a DOMAIN-tier (`asset`) dataset, which is the ceiling for its metrics. */
function rec(over: Parameters<typeof goldSales>[0] = {}) {
  const d = goldSales(over);
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
  // The dataset is a CERTIFIED data product here, because a metric may not be certified above the
  // tier of the data it reads (M12, asserted on its own below).
  const promoted = await governMetric(rec({ tier: 'product' }), 'promote', { id: 'bea', role: 'builder' }, resolve);
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

// --------------------------------------------- M12: the dataset ceiling ---
// A metric is a measure on a dataset: every number it serves is read from that dataset's table
// through that dataset's grants. Publishing the metric wider than the data underneath it promises
// an audience a number row-level security will refuse them, so the dataset's tier is the ceiling.

test('M12: a metric cannot be CERTIFIED above the tier of the dataset it reads', async () => {
  const promoted = await governMetric(rec(), 'promote', { id: 'bea', role: 'builder' }, resolve);
  assert.ok(promoted.ok, promoted.reason);
  const denied = await governMetric(promoted.record, 'certify', { id: 'sara', role: 'admin' }, resolve);
  assert.equal(denied.ok, false, 'an Admin may certify, but not past the data');
  assert.match(denied.reason ?? '', /dataset tier ceiling/);
  assert.match(denied.reason ?? '', /'Sales'/, 'the refusal NAMES the dataset, so the fix is obvious');
  assert.match(denied.reason ?? '', /promote the dataset first/);
  assert.equal(denied.record.tier, 'domain', 'the refused transition leaves the tier where it was');
});

test('M12: a metric cannot be PROMOTED above a Personal dataset', async () => {
  const denied = await governMetric(rec({ tier: 'dataset' }), 'promote', { id: 'bea', role: 'builder' }, resolve);
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? '', /dataset tier ceiling: 'Sales' is Personal/);
  assert.equal(denied.record.tier, 'personal');
});

test('M12: AT the ceiling is allowed — the rule is a ceiling, not a gap', async () => {
  const toDomain = await governMetric(rec({ tier: 'asset' }), 'promote', { id: 'bea', role: 'builder' }, resolve);
  assert.ok(toDomain.ok, toDomain.reason);
  assert.equal(toDomain.record.tier, 'domain');
  const toCompany = await governMetric(toDomain.record, 'certify', { id: 'sara', role: 'admin' }, resolve);
  assert.equal(toCompany.ok, false, 'Domain data, Domain metric — Company is above the ceiling');
  const onProduct = await governMetric(
    { ...toDomain.record, dataset: { ...toDomain.record.dataset, tier: 'product' } },
    'certify',
    { id: 'sara', role: 'admin' },
    resolve,
  );
  assert.ok(onProduct.ok, onProduct.reason);
  assert.equal(onProduct.record.tier, 'marketplace');
});

test('M12: the ROLE gate still answers first — a refusal names one reason at a time', async () => {
  // A creator promoting a metric on a Personal dataset breaks two rules; the role gate is the one
  // reported, because it is the cheapest to fix and the one the UI already explains.
  const r = await governMetric(rec({ tier: 'dataset' }), 'promote', { id: 'amir', role: 'creator' }, resolve);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /Builder/);
  assert.doesNotMatch(r.reason ?? '', /ceiling/);
});

test('role predicates drive the UI buttons', () => {
  assert.equal(canPromote('creator'), false);
  assert.equal(canPromote('builder'), true);
  assert.equal(canCertify('builder'), false);
  assert.equal(canCertify('admin'), true);
});
