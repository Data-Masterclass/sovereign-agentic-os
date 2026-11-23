/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/software/apps.ts → listAppsForUser.
 * Every tier (My/Domain/Company) narrows to the active domain. An app created in
 * domain A is hidden when domain B is active, shown when A is active, shown under
 * "All Domains".
 * COMPANY EXCEPTION (owner decision 2026-11-23, core/kernel/company-scope): a Company item
 * is visible in EVERY domain, so the Company case asserts it is SHOWN in domain B.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing apps.ts so every OpenSearch ping fails fast
// (offline mode) — mirrors lib/software/apps.test.ts.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetAppsCache, createApp, promoteApp, listAppsForUser, getAppForUser, renameApp } = await import('./apps.ts');

// user.domains[0] stamps the app's domain → 'sales'.
const uAll = { id: 'u1', name: 'U1', domains: ['sales', 'finance'], role: 'admin' as const };
const uSales = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };
const uFinance = { id: 'u1', name: 'U1', domains: ['finance'], role: 'admin' as const };

async function seedSales(tier: 0 | 1 | 2): Promise<string> {
  const a = await createApp(uAll, { name: `App ${tier} ${Math.random().toString(36).slice(2, 6)}`, template: 'empty' });
  if (tier >= 1) await promoteApp(a.id, uAll); // → Shared
  if (tier >= 2) await promoteApp(a.id, uAll); // → Certified (Company)
  return a.id;
}

async function ids(u: typeof uAll): Promise<Set<string>> {
  return new Set((await listAppsForUser(u)).map((a) => a.id));
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`${label} app in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, async () => {
    __resetAppsCache();
    const id = await seedSales(tier);
    if (label === 'Company') assert.ok((await ids(uFinance)).has(id), `${label} sales app VISIBLE (Company: every domain) in finance`);
    else assert.ok(!(await ids(uFinance)).has(id), `${label} sales app HIDDEN in finance`);
    assert.ok((await ids(uSales)).has(id), `${label} sales app SHOWN in sales`);
    assert.ok((await ids(uAll)).has(id), `${label} sales app SHOWN under All Domains`);
  });
}


// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed = { id: 'zed', name: 'Zed', domains: ['finance'], role: 'creator' as const };

test('Company app from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', async () => {
  __resetAppsCache();
  const company = await seedSales(2);
  const domainOnly = await seedSales(1);
  const listed = await ids(zed);
  assert.ok(listed.has(company), 'listed');
  assert.equal((await getAppForUser(company, zed)).id, company, 'opened by id');
  await assert.rejects(renameApp(company, zed, 'Hijacked'), 'cannot edit');
  assert.ok(!listed.has(domainOnly), 'Domain twin NOT listed');
  await assert.rejects(getAppForUser(domainOnly, zed), 'Domain twin NOT openable');
});

test('restore fetch', () => { globalThis.fetch = _realFetch; });
