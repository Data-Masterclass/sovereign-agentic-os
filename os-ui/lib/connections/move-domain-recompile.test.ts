/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * M4 — moveConnectionsDomain must recompile the OPA exposure bundle when it moves a
 * warehouse/operational connection (whose grants are keyed by the connection's domain);
 * a non-exposure-backing connection (e.g. a plain database) must NOT trigger a recompile.
 * We spy on the dynamically-imported recompileExposures via node:test module mocks.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

let recompileCalls = 0;
mock.module('@/lib/connections/exposure-policy', {
  namedExports: {
    recompileExposures: async () => { recompileCalls++; return { ok: true, pushed: 0, detail: 'spy' }; },
    exposureFqns: async () => [],
  },
});

const { createConnection, moveConnectionsDomain, __resetConnections } = await import('./store.ts');
const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };

beforeEach(() => { __resetConnections(); recompileCalls = 0; });

test('M4: moving a warehouse connection recompiles exposures', async () => {
  const c = await createConnection(admin, {
    name: 'WH', template: 'warehouse', endpoint: '', credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
  const moved = await moveConnectionsDomain({ id: c.id }, 'commerce');
  assert.deepEqual(moved, [c.id]);
  assert.equal(recompileCalls, 1, 'recompile fired for a warehouse move');
});

test('M4: moving an operational connection recompiles exposures', async () => {
  const c = await createConnection(admin, {
    name: 'SF', template: 'salesforce-api', endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs',
  });
  await moveConnectionsDomain({ id: c.id }, 'commerce');
  assert.equal(recompileCalls, 1, 'recompile fired for an operational move');
});

test('M4: moving a plain database connection does NOT recompile', async () => {
  const c = await createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  await moveConnectionsDomain({ id: c.id }, 'commerce');
  assert.equal(recompileCalls, 0, 'no recompile for a non-exposure-backing connection');
});
