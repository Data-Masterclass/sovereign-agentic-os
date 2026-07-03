/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSee, filterScope, assertInScope, deriveScope } from './scope-core.ts';
import { allMockItems, SALES_OWNER, OTHER_OWNER } from './mock.ts';

const userSales = deriveScope('creator', SALES_OWNER, ['sales']);
const builderSales = deriveScope('builder', 'b_sales', ['sales']);
const builderFinance = deriveScope('builder', 'b_fin', ['finance']);
const admin = deriveScope('admin', 'a_root', ['sales', 'finance', 'platform']);

test('role → scope level mapping (participant=user, builder, admin sees cluster)', () => {
  assert.equal(userSales.level, 'user');
  assert.equal(builderSales.level, 'builder');
  assert.equal(admin.level, 'admin');
  assert.equal(admin.cluster, true);
  assert.equal(userSales.cluster, false);
});

test('USER sees only their OWN signals', () => {
  const own = { owner: SALES_OWNER, domain: 'sales' };
  const other = { owner: OTHER_OWNER, domain: 'finance' };
  const sameDomainOtherOwner = { owner: 'someone_else', domain: 'sales' };
  assert.equal(canSee(userSales, own), true);
  assert.equal(canSee(userSales, other), false);
  // crucial: a user does NOT see another user's item even in the same domain
  assert.equal(canSee(userSales, sameDomainOtherOwner), false);
});

test('BUILDER sees their DOMAIN, not other domains', () => {
  assert.equal(canSee(builderSales, { owner: 'anyone', domain: 'sales' }), true);
  assert.equal(canSee(builderSales, { owner: 'anyone', domain: 'finance' }), false);
  assert.equal(canSee(builderFinance, { owner: 'anyone', domain: 'finance' }), true);
});

test('CLUSTER/tenant signals are ADMIN-only (builder & user cannot see a node)', () => {
  const node = { owner: 'platform', domain: 'platform', cluster: true };
  assert.equal(canSee(admin, node), true);
  assert.equal(canSee(builderSales, node), false);
  assert.equal(canSee(userSales, node), false);
});

test('ADMIN sees everything (tenant + cluster)', () => {
  for (const it of allMockItems()) assert.equal(canSee(admin, it), true);
});

test('SECURITY INVARIANT: a User cannot open another user\'s trace (assertInScope → 403)', () => {
  const othersTrace = { owner: OTHER_OWNER, domain: 'finance' };
  assert.throws(
    () => assertInScope(userSales, othersTrace),
    (e: Error & { status?: number }) => e.status === 403,
  );
  // ...but CAN open their own
  assert.doesNotThrow(() => assertInScope(userSales, { owner: SALES_OWNER, domain: 'sales' }));
});

test('assertInScope throws 404 for a missing trace', () => {
  assert.throws(
    () => assertInScope(userSales, null),
    (e: Error & { status?: number }) => e.status === 404,
  );
});

test('filterScope keeps only in-scope items', () => {
  const items = allMockItems();
  const userVisible = filterScope(userSales, items);
  // every visible item is owned by the sales user
  assert.ok(userVisible.length > 0);
  for (const it of userVisible) assert.equal(it.owner, SALES_OWNER);
  // none of the finance/other-owner items leak through
  assert.equal(userVisible.some((i) => i.owner === OTHER_OWNER), false);
  // builder-finance sees finance-domain items, not sales
  const finVisible = filterScope(builderFinance, items);
  assert.ok(finVisible.every((i) => i.domain === 'finance'));
});
