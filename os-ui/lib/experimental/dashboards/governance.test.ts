/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRecord, governDashboard, canPromote, canCertify } from './governance.ts';
import { fromTiles, viewFor } from './model.ts';
import { goldSales } from '../metrics/fixtures.ts';

function rec() {
  const view = viewFor(goldSales());
  const spec = fromTiles('Sales Overview', view, [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' }]);
  return dashboardRecord('dash1', spec, 'amir', 'personal');
}

test('Builder promotes Personal → Domain; a participant cannot', () => {
  assert.equal(governDashboard(rec(), 'promote', { id: 'bea', role: 'builder' }).record.tier, 'domain');
  const denied = governDashboard(rec(), 'promote', { id: 'amir', role: 'creator' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? '', /Builder/);
});

test('Admin certifies Domain → Marketplace; a Builder cannot', () => {
  const promoted = governDashboard(rec(), 'promote', { id: 'bea', role: 'builder' }).record;
  assert.equal(governDashboard(promoted, 'certify', { id: 'sara', role: 'admin' }).record.tier, 'marketplace');
  const denied = governDashboard(promoted, 'certify', { id: 'bea', role: 'builder' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? '', /Admin/);
});

test('role predicates match data + metrics', () => {
  assert.equal(canPromote('builder'), true);
  assert.equal(canPromote('creator'), false);
  assert.equal(canCertify('admin'), true);
  assert.equal(canCertify('builder'), false);
});
