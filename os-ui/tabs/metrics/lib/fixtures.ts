/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { emptyVersions, claimsFromUser, delegate, type Dataset, type DelegatedToken } from '@tabs/data/lib/index';

/** A built, documented Gold "Sales" dataset — the shared test fixture for the
 *  Metrics/Dashboards spine (kept out of *.test.ts so importing it never re-runs
 *  another file's tests). */
export function goldSales(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true; versions.silver.built = true; versions.gold.built = true;
  return {
    version: '1', id: 'ds_sales', name: 'Sales', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', folder: '/', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'order_date', description: 'When.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

/**
 * A user-delegated DOMAIN token for a metrics test.
 *
 * Every metric read asserts the token is user-delegated (`propagate` throws otherwise), so a test
 * of the read path needs a real one. It lives HERE rather than in each test file because the
 * helpers are in the Data tab and `scripts/check-structure.mjs` ratchets cross-tab imports — one
 * import in the fixtures module is one violation, a copy per test file is one each.
 */
export function viewerToken(
  over: { id?: string; domains?: string[]; role?: 'creator' | 'builder' | 'domain_admin' | 'admin'; attributes?: Record<string, string> } = {},
): DelegatedToken {
  const claims = claimsFromUser({
    id: over.id ?? 'amir',
    domains: over.domains ?? ['sales'],
    role: over.role ?? 'domain_admin',
    attributes: over.attributes ?? { region: 'DE' },
  });
  return delegate(claims, 'domain');
}
