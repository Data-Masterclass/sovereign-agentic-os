/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Data tab's OPA restore waits for the dataset registry.
 * USER STORY: As a domain member I want my governed tables back in OPA after os-ui boots, even
 *             when OpenSearch comes up after os-ui, instead of a "restored" with zero tables.
 * ARCHITECTURE:
 *   - The store, the roster and the OPA publisher are module mocks (a SLOW store: unhydrated on
 *     the first call, hydrated on the second); the real-OPA restore is
 *     tests/opa/state-reconcile.int.test.ts.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let hydrated = false;
const writes: string[] = [];
const dataset = {
  id: 'd1', name: 'Orders', slug: 'orders', domain: 'kiekert', tier: 'asset', visibility: 'domain',
  grants: [], imports: [],
};

mock.module('@tabs/data/lib/store', {
  namedExports: {
    ensureHydrated: async () => undefined,
    hydrationState: () => (hydrated ? 'hydrated' : 'failed'),
    listAllDatasets: () => (hydrated ? [dataset] : []),
  },
});
mock.module('@tabs/data/lib/build/live-clients', {
  namedExports: { buildRoster: async () => ({ ada: { domains: ['kiekert'] } }) },
});
mock.module('@core/policy/opa-publish', {
  namedExports: {
    publishOpaAll: async (ws: { path: string }[]) => {
      for (const w of ws) writes.push(w.path);
      return { ok: true, written: ws.length, detail: `${ws.length} write(s)` };
    },
  },
});
mock.module('@tabs/data/lib/policy/compiler', {
  namedExports: {
    compileOpa: (ds: { domain: string }[], roster: Record<string, { domains: string[] }>, extra: string[]) => ({
      tables: Object.fromEntries(ds.map((d) => [`iceberg.${d.domain}.gold_orders`, { domain: d.domain, visibility: 'domain', shared_with: [], shared_with_users: [], sensitive_columns: {} }])),
      principals: Object.fromEntries([...Object.entries(roster).map(([k, v]) => [k, { domains: v.domains, clearances: [] }]), ...extra.map((d) => [d, { domains: [d], clearances: [] }])]),
    }),
  },
});

test('an unhydrated dataset registry refuses the restore; once hydrated the tables are written', async () => {
  const { restoreDataGovernance } = await import('@tabs/data/lib/policy/opa-state');
  const first = await restoreDataGovernance(async () => ['kiekert']);
  assert.equal(first.ok, false, 'never "restored" with an empty, unread registry');
  assert.match(first.detail, /dataset registry not hydrated yet \(failed\)/);
  assert.deepEqual(writes, [], 'nothing written from an unread registry');

  hydrated = true; // the slow store finally read its mirror
  const second = await restoreDataGovernance(async () => ['kiekert']);
  assert.equal(second.ok, true, second.detail);
  assert.match(second.detail, /^1 table\(s\)/);
  assert.ok(writes.includes('governance/tables/iceberg.kiekert.gold_orders'));
});
