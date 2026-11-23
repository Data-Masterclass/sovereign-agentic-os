/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Active-domain scope tests for lib/connections/store.ts → listConnectionsForUser
 *
 * Rule: a Personal connection owned by the caller in domain A must be hidden
 * when domain B is active, visible when A is active, and visible under "All
 * Domains". My and Domain (Shared) narrow to the active domain via visibleToUser →
 * user.domains.includes(c.domain); a domainless connection always shows. A Certified
 * ("Company") connection is visible in EVERY domain (owner decision 2026-11-23,
 * core/kernel/company-scope) — read only; managing it stays owner/domain admin/admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch before importing so OpenSearch ping fails fast (offline mode).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, listConnectionsForUser, __resetConnections } = await import('./store.ts');

// Builder in both sales + finance (All Domains view).
const builderAll = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['sales', 'finance'] };
// Builder with active domain = sales only.
const builderSales = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['sales'] };
// Builder with active domain = finance only.
const builderFinance = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['finance'] };

test('Personal connection in domain A is hidden when active domain is B', async () => {
  __resetConnections();
  // Create a Personal connection in the sales domain.
  const c = await createConnection(builderAll, {
    name: 'Sales DB',
    template: 'database',
    endpoint: '',
    credential: 'pw',
    domain: 'sales',
  });
  assert.equal(c.visibility, 'Personal');
  assert.equal(c.domain, 'sales');

  // Active domain = finance → Personal connection in sales must NOT appear.
  const visibleFinance = await listConnectionsForUser(builderFinance);
  assert.ok(!visibleFinance.some((x) => x.id === c.id), 'sales Personal connection must be hidden when active domain is finance');
});

test('Personal connection in domain A is shown when active domain is A', async () => {
  __resetConnections();
  const c = await createConnection(builderAll, {
    name: 'Sales DB',
    template: 'database',
    endpoint: '',
    credential: 'pw',
    domain: 'sales',
  });

  const visibleSales = await listConnectionsForUser(builderSales);
  assert.ok(visibleSales.some((x) => x.id === c.id), 'sales Personal connection must be visible when active domain is sales');
});

test('Personal connection in domain A is shown under All Domains', async () => {
  __resetConnections();
  const c = await createConnection(builderAll, {
    name: 'Sales DB',
    template: 'database',
    endpoint: '',
    credential: 'pw',
    domain: 'sales',
  });

  const visibleAll = await listConnectionsForUser(builderAll);
  assert.ok(visibleAll.some((x) => x.id === c.id), 'sales Personal connection must be visible under All Domains');
});

test('Shared connection in domain A is hidden when active domain is B', async () => {
  __resetConnections();
  const domainAdmin = { id: 'da', name: 'DA', role: 'domain_admin' as const, domains: ['sales'] };
  const { promoteConnection } = await import('./store.ts');
  const c = await createConnection(builderAll, {
    name: 'Shared Sales API',
    template: 'database',
    endpoint: '',
    credential: 'pw',
    domain: 'sales',
  });
  await promoteConnection(c.id, domainAdmin); // Personal → Shared
  assert.equal((await import('./store.ts').then(m => m.getConnectionForUser(c.id, builderAll))).visibility, 'Shared');

  // Active domain = finance → Shared connection in sales must NOT appear.
  const visibleFinance = await listConnectionsForUser(builderFinance);
  assert.ok(!visibleFinance.some((x) => x.id === c.id), 'Shared sales connection must be hidden when active domain is finance');
});

test('CERTIFIED (Company) connection in domain A: SHOWN in B (list + get), shown in A + All Domains', async () => {
  __resetConnections();
  const admin = { id: 'ad', name: 'AD', role: 'admin' as const, domains: ['sales'] };
  const { promoteConnection, getConnectionForUser } = await import('./store.ts');
  const c = await createConnection(builderAll, {
    name: 'Certified Sales API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales',
  });
  await promoteConnection(c.id, admin); // Personal → Shared
  await promoteConnection(c.id, admin); // Shared → Certified (Company)
  assert.equal((await getConnectionForUser(c.id, builderAll)).visibility, 'Certified');

  // Company scope: a Certified connection homed in sales is visible in finance too.
  assert.ok((await listConnectionsForUser(builderFinance)).some((x) => x.id === c.id),
    'Certified sales connection must be visible when active domain is finance');
  assert.equal((await getConnectionForUser(c.id, builderFinance)).id, c.id, 'get by id works from finance');
  assert.ok((await listConnectionsForUser(builderSales)).some((x) => x.id === c.id),
    'Certified sales connection must be shown when active domain is sales');
  assert.ok((await listConnectionsForUser(builderAll)).some((x) => x.id === c.id),
    'Certified sales connection must be shown under All Domains');
});

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

test('Company connection from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', async () => {
  __resetConnections();
  const admin = { id: 'ad', name: 'AD', role: 'admin' as const, domains: ['sales'] };
  const zed = { id: 'zed', name: 'Zed', role: 'creator' as const, domains: ['finance'] };
  const { promoteConnection, getConnectionForUser, renameConnection } = await import('./store.ts');
  const company = await createConnection(builderAll, { name: 'Company API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales' });
  await promoteConnection(company.id, admin); await promoteConnection(company.id, admin); // → Certified
  const domainOnly = await createConnection(builderAll, { name: 'Sales API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales' });
  await promoteConnection(domainOnly.id, admin); // → Shared
  const listed = await listConnectionsForUser(zed);
  assert.ok(listed.some((x) => x.id === company.id), 'listed');
  assert.equal((await getConnectionForUser(company.id, zed)).id, company.id, 'opened by id');
  await assert.rejects(renameConnection(company.id, zed, 'Hijacked'), 'cannot edit');
  assert.ok(!listed.some((x) => x.id === domainOnly.id), 'Domain twin NOT listed');
  await assert.rejects(getConnectionForUser(domainOnly.id, zed), 'Domain twin NOT openable');
});
