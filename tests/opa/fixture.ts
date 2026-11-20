/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Seed os-ui's own stores, through the OS's own functions, at the scale of the live install
 * (20 Nov 2026: 155 grant principals, 19 governance tables, 101 governance principals): users in
 * a dozen domains, registered domains, governed datasets, an agent-system grant contributor.
 * Then register the shipped OPA state sources (`opa-state-sources.ts`).
 */
export const RUNTIME_DOMAIN = 'agentic-leader-autumn-winter-2026-2027';
export const DOMAINS = [RUNTIME_DOMAIN, 'test', 'sales', ...Array.from({ length: 9 }, (_, i) => `cohort-${String(i + 1).padStart(2, '0')}`)];

export type Scale = { users: number; tables: number };
export const LIVE_SCALE: Scale = { users: 140, tables: 16 }; // + chart seeds ≈ 155 grant principals, 19 tables

export async function seedOsState(scale: Scale = LIVE_SCALE): Promise<void> {
  const { createUser, knownDomains } = await import('@tabs/admin/lib/users');
  const domains = await import('@tabs/admin/lib/domains');
  await domains.ensureHydrated(knownDomains);
  for (const d of DOMAINS) if (!domains.listDomains().some((x) => x.id === d)) domains.createDomain({ name: d, owner: 'admin' });
  for (let i = 0; i < scale.users; i++) {
    const id = `u${String(i).padStart(3, '0')}`;
    const domain = i === 0 ? RUNTIME_DOMAIN : DOMAINS[i % DOMAINS.length];
    await createUser({ id, email: `${id}@example.com`, password: 'S0me-Long-Passphrase!', domains: [domain], role: i % 7 === 0 ? 'builder' : 'creator' });
  }
  const store = await import('@tabs/data/lib/store');
  await store.ensureHydrated();
  for (let t = 0; t < scale.tables; t++) {
    const domain = DOMAINS[t % DOMAINS.length];
    store.__seedDatasetForTest({ id: `ds_${t}`, name: `table_${t}`, owner: `u${String(t).padStart(3, '0')}`, domain, tier: t % 3 === 0 ? 'product' : 'asset' });
  }
  const { registerOpaStateSources } = await import('../../os-ui/opa-state-sources.ts');
  registerOpaStateSources();
  const { registerGrantContributor } = await import('@core/policy/opa-reconcile');
  registerGrantContributor({ name: 'test-agent-system', grants: async () => ({ 'os-sys-it': ['query', 'search_knowledge'] }) });
}
