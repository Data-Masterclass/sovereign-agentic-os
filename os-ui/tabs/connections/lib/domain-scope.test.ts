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

test('CERTIFIED (Company) connection in domain A: SEEN (redacted) in B, never usable there; usable in A + All Domains', async () => {
  __resetConnections();
  const admin = { id: 'ad', name: 'AD', role: 'admin' as const, domains: ['sales'] };
  const { promoteConnection, getConnectionForUser, listConnectionsVisible } = await import('./store.ts');
  const c = await createConnection(builderAll, {
    name: 'Certified Sales API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales',
  });
  await promoteConnection(c.id, admin); // Personal → Shared
  await promoteConnection(c.id, admin); // Shared → Certified (Company)
  assert.equal((await getConnectionForUser(c.id, builderAll)).visibility, 'Certified');

  // SEE, NOT USE (owner decision 2026-11-23): finance sees it redacted, but the use list and the
  // use gate (every credential-backed path, picker and tool call) keep it out.
  assert.ok(!(await listConnectionsForUser(builderFinance)).some((x) => x.id === c.id), 'NOT in finance\'s usable list');
  await assert.rejects(getConnectionForUser(c.id, builderFinance), 'the use gate refuses it from finance');
  const seen = await listConnectionsVisible(builderFinance);
  assert.ok(seen.companyFromOtherDomains.some((x) => x.id === c.id && x.usable === false), 'seen, redacted, in finance');
  assert.ok((await listConnectionsForUser(builderSales)).some((x) => x.id === c.id),
    'Certified sales connection must be shown when active domain is sales');
  assert.ok((await listConnectionsForUser(builderAll)).some((x) => x.id === c.id),
    'Certified sales connection must be shown under All Domains');
});

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

test('Company connection from sales: a finance member SEES it redacted, cannot use or edit it; Domain twin hidden', async () => {
  __resetConnections();
  const admin = { id: 'ad', name: 'AD', role: 'admin' as const, domains: ['sales'] };
  const zed = { id: 'zed', name: 'Zed', role: 'creator' as const, domains: ['finance'] };
  const { promoteConnection, getConnectionForUser, getConnectionView, listConnectionsVisible, renameConnection, callConnectionTool } = await import('./store.ts');
  const company = await createConnection(builderAll, { name: 'Company API', template: 'database', endpoint: '', credential: 'pw-secret', domain: 'sales' });
  await promoteConnection(company.id, admin); await promoteConnection(company.id, admin); // → Certified
  const domainOnly = await createConnection(builderAll, { name: 'Sales API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales' });
  await promoteConnection(domainOnly.id, admin); // → Shared

  // SEE: list + get return the redacted projection only.
  const { usable, companyFromOtherDomains } = await listConnectionsVisible(zed);
  assert.ok(companyFromOtherDomains.some((x) => x.id === company.id), 'seen in the Company list');
  const view = await getConnectionView(company.id, zed);
  assert.deepEqual(Object.keys(view).sort(), ['domain', 'health', 'id', 'name', 'redacted', 'template', 'toolNames', 'type', 'usable', 'visibility']);
  const raw = JSON.stringify([view, companyFromOtherDomains]);
  for (const leak of ['pw-secret', 'secretRef', 'secretFingerprint', 'principal', 'endpoint', 'egress', 'grants', 'dataUsage', 'owner']) {
    assert.ok(!raw.includes(leak), `no ${leak} in the cross-domain view`);
  }

  // USE: refused on every gate — the usable list (pickers, grantable, context), the use getter
  // (every credential-backed helper and the autonomous route), and the tool call itself.
  assert.ok(!usable.some((x) => x.id === company.id), 'not usable');
  assert.ok(!(await listConnectionsForUser(zed)).some((x) => x.id === company.id), 'pickers never offer it');
  await assert.rejects(getConnectionForUser(company.id, zed), (e: { status?: number }) => e.status === 404, 'use gate 404');
  await assert.rejects(callConnectionTool(company.id, zed as never, { tool: 'query', args: { sql: 'select 1' } }), (e: { status?: number }) => e.status === 404, 'tool call refused');
  await assert.rejects(renameConnection(company.id, zed, 'Hijacked'), 'cannot edit');

  // Negative twin + the owning domain keeps full use.
  assert.ok(!companyFromOtherDomains.some((x) => x.id === domainOnly.id), 'Domain twin NOT seen');
  await assert.rejects(getConnectionView(domainOnly.id, zed), 'Domain twin NOT openable');
  assert.ok('secretRef' in (await getConnectionView(company.id, builderSales)), 'own domain gets the full record');
});

test('an ARCHIVED Company connection is not seen by other domains (an admin still sees it)', async () => {
  __resetConnections();
  const admin = { id: 'ad', name: 'AD', role: 'admin' as const, domains: ['sales'] };
  const zed = { id: 'zed', name: 'Zed', role: 'creator' as const, domains: ['finance'] };
  const finAdmin = { id: 'fa', name: 'FA', role: 'admin' as const, domains: ['finance'] };
  const { promoteConnection, setConnectionArchived, listConnectionsVisible, getConnectionView } = await import('./store.ts');
  const c = await createConnection(builderAll, { name: 'Old API', template: 'database', endpoint: '', credential: 'pw', domain: 'sales' });
  await promoteConnection(c.id, admin); await promoteConnection(c.id, admin);
  await setConnectionArchived(c.id, admin, true);
  assert.ok(!(await listConnectionsVisible(zed, { includeArchived: true })).companyFromOtherDomains.some((x) => x.id === c.id));
  await assert.rejects(getConnectionView(c.id, zed));
  assert.equal((await getConnectionView(c.id, finAdmin)).id, c.id, 'an admin still sees it');
});
