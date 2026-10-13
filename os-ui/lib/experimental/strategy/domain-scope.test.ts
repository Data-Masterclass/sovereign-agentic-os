/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Active-domain scope tests for lib/strategy/pillars.ts
 *
 * Rule: a personal (My) pillar created in domain A must be hidden when domain B
 * is active, visible when domain A is active, and visible when "All Domains"
 * is active. Domain (Shared) pillars already narrow via canViewPillar →
 * entitledToDomain. Company (tenant) pillars are never narrowed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPillar, listPillars, __resetForTests } from './pillars.ts';

const admin = { id: 'admin', name: 'Admin', role: 'admin' as const, domains: ['platform', 'sales', 'finance'] };

// User acting in ALL domains (no active domain chosen).
const userAll = { id: 'u1', name: 'U1', role: 'creator' as const, domains: ['sales', 'finance'] };
// User with active domain = sales only (user.domains narrowed to ['sales']).
const userSales = { id: 'u1', name: 'U1', role: 'creator' as const, domains: ['sales'] };
// User with active domain = finance only.
const userFinance = { id: 'u1', name: 'U1', role: 'creator' as const, domains: ['finance'] };

test('personal pillar in domain A is hidden when active domain is B', async () => {
  __resetForTests();
  // Create a personal pillar in the sales domain.
  const p = await createPillar(userAll, { name: 'Sales Pillar', scope: 'personal', domain: 'sales' });
  assert.equal(p.scope, 'personal');
  assert.equal(p.domain, 'sales');

  // When active domain is finance, the sales personal pillar must NOT appear.
  const visibleFinance = await listPillars(userFinance);
  assert.ok(!visibleFinance.some((x) => x.id === p.id), 'personal pillar in sales must be hidden when active domain is finance');
});

test('personal pillar in domain A is shown when active domain is A', async () => {
  __resetForTests();
  const p = await createPillar(userAll, { name: 'Sales Pillar', scope: 'personal', domain: 'sales' });

  // When active domain is sales, the sales personal pillar MUST appear.
  const visibleSales = await listPillars(userSales);
  assert.ok(visibleSales.some((x) => x.id === p.id), 'personal pillar in sales must be visible when active domain is sales');
});

test('personal pillar in domain A is shown under All Domains', async () => {
  __resetForTests();
  const p = await createPillar(userAll, { name: 'Sales Pillar', scope: 'personal', domain: 'sales' });

  // When "All Domains" is active (user.domains = all memberships), the pillar appears.
  const visibleAll = await listPillars(userAll);
  assert.ok(visibleAll.some((x) => x.id === p.id), 'personal pillar must be visible under All Domains');
});

test('Company (tenant) pillar is never narrowed by active domain', async () => {
  __resetForTests();
  const tp = await createPillar(admin, { name: 'Company Pillar', scope: 'tenant' });
  assert.equal(tp.scope, 'tenant');

  // Company pillars are tenant-wide — always visible regardless of active domain.
  const vSales = await listPillars(userSales);
  const vFinance = await listPillars(userFinance);
  assert.ok(vSales.some((x) => x.id === tp.id), 'Company pillar must be visible when active domain is sales');
  assert.ok(vFinance.some((x) => x.id === tp.id), 'Company pillar must be visible when active domain is finance');
});

test('Domain pillar in sales is hidden when active domain is finance', async () => {
  __resetForTests();
  const domainAdmin = { id: 'da', name: 'DA', role: 'domain_admin' as const, domains: ['sales'] };
  const dp = await createPillar(domainAdmin, { name: 'Sales Domain Pillar', scope: 'domain', domain: 'sales' });
  assert.equal(dp.scope, 'domain');

  // Domain pillar is only visible to members of that domain.
  const vFinance = await listPillars(userFinance);
  assert.ok(!vFinance.some((x) => x.id === dp.id), 'Domain pillar in sales must be hidden when active domain is finance');

  const vSales = await listPillars(userSales);
  assert.ok(vSales.some((x) => x.id === dp.id), 'Domain pillar in sales must be visible when active domain is sales');
});
