/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * M7 — testConnection must NEVER claim health it did not verify:
 *   • warehouse whose catalog is not queryable (offline Trino) → ok:false + untested,
 *     not the old ok:true/mode:offline "success".
 *   • warehouse platform with no safe live probe (Fabric) → ok:false + untested.
 *   • a generic template with no authenticated round-trip → ok:false + untested; the
 *     connection is left health:'untested', never 'healthy' on a bare credential/HEAD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, testConnection, getConnectionForUser, __resetConnections } = await import('./store.ts');
const builder = { id: 'b1', name: 'B', domains: ['sales'], role: 'builder' as const };

test('M7 warehouse: offline/unregistered catalog → ok:false + untested (no fake success)', async () => {
  __resetConnections();
  const c = await createConnection(builder, {
    name: 'Glue', template: 'warehouse', endpoint: '', credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
  const r = await testConnection(c.id, builder);
  assert.equal(r.ok, false, 'not ok — the catalog is not queryable');
  assert.match(r.detail, /not queryable yet/i);
  const got = await getConnectionForUser(c.id, builder);
  assert.equal(got.health, 'untested', 'health left untested, never healthy');
});

test('M7 warehouse: no-safe-probe platform (Fabric) → ok:false + untested', async () => {
  __resetConnections();
  const c = await createConnection(builder, {
    name: 'Fabric', template: 'warehouse', endpoint: '', credential: '',
    warehouse: {
      platform: 'fabric', catalog: 'fab_lake',
      fields: {
        workspaceId: 'ws-1', onelakeEndpoint: 'onelake.dfs.fabric.microsoft.com',
        tenantId: 't1', 'fabric-sp-client-id': 'cid', 'fabric-sp-secret': 'shh',
      },
    },
  });
  const r = await testConnection(c.id, builder);
  assert.equal(r.ok, false);
  assert.match(r.detail, /NOT verified|no safe live probe/i);
  assert.equal((await getConnectionForUser(c.id, builder)).health, 'untested');
});

test('M7 generic: a template with no authenticated round-trip → ok:false + untested', async () => {
  __resetConnections();
  // `database` has no CONNECTION_HEALTH probe → falls through to the generic branch.
  const c = await createConnection(builder, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const r = await testConnection(c.id, builder);
  assert.equal(r.ok, false, 'never a fake healthy on a bare credential-presence check');
  assert.match(r.detail, /UNTESTED/);
  assert.equal((await getConnectionForUser(c.id, builder)).health, 'untested');
});

test.after(() => { globalThis.fetch = _realFetch; });
