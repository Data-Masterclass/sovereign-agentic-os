/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Governance + wiring test for the store's warehouse discover/register seam.
 * Offline-stubs fetch (so getCache() starts empty + queryRun degrades) and injects a
 * FAKE k8s client so registerWarehouseCatalog exercises the real gate without a cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlob } from '@core/infra/git-store';

// Force external connectors ON for this suite (createConnection gates on it).
(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
// WP-50: the registration commits the catalog to the domain repo first, so the suite gets a repo dir.
(config as { reposDir: string }).reposDir = mkdtempSync(join(tmpdir(), 'os-wh-register-'));

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, registerWarehouseCatalog, discoverWarehouse, __resetConnections } =
  await import('./store.ts');
import type { RegK8s } from '@tabs/connections/lib/warehouse/k8s-registration';

const builder = { id: 'b1', name: 'B', domains: ['sales'], role: 'builder' as const };
// A different in-domain participant who does NOT own the (Personal) connection.
const creator = { id: 'c1', name: 'C', domains: ['sales'], role: 'creator' as const };

function recordingK8s(status = 200) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const k8s: RegK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && /secrets\/trino-ext-/.test(path)) return { status: 404, body: {} };
    return { status, body: {} };
  };
  return { k8s, calls };
}

async function glueConn(owner = builder) {
  return createConnection(owner, {
    name: 'Glue sales',
    template: 'warehouse',
    endpoint: '',
    credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
}

test('registerWarehouseCatalog: builder+owner registers Glue live (ConfigMap + rollout, no secret)', async () => {
  __resetConnections();
  const c = await glueConn();
  const { k8s, calls } = recordingK8s(200);
  const out = await registerWarehouseCatalog(c.id, builder, { k8s });
  assert.equal(out.ok, true);
  assert.equal(out.catalog, 'glue_sales');
  assert.ok(calls.some((x) => x.path.endsWith('/configmaps/trino-catalog')), 'merged the ConfigMap');
  assert.ok(!calls.some((x) => /\/secrets/.test(x.path)), 'keyless — no Secret');
  // WP-50 (C4): Trino got the COMMITTED bytes, and the ConfigMap names their sha.
  assert.equal(out.source, 'git');
  const cm = calls.find((x) => x.path.endsWith('/configmaps/trino-catalog'))!.body as { data: Record<string, string>; metadata: { annotations: Record<string, string> } };
  const committed = await readBlob('sales', out.gitSha, 'connections/glue_sales/catalog.properties', { reposDir: config.reposDir });
  assert.equal(cm.data['glue_sales.properties'], committed);
  assert.equal(cm.metadata.annotations['sovereign-os.io/connections-sha.glue_sales'], out.gitSha);
});

test('registerWarehouseCatalog gate: a non-owning creator is refused (Personal → 404, no leak)', async () => {
  __resetConnections();
  const c = await glueConn(builder); // Personal, owned by builder — not visible to others
  const { k8s } = recordingK8s(200);
  await assert.rejects(
    () => registerWarehouseCatalog(c.id, creator, { k8s }),
    /not found|not permitted|requires a Builder/i,
  );
});


test('registerWarehouseCatalog: non-warehouse connection is rejected', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const { k8s } = recordingK8s(200);
  await assert.rejects(() => registerWarehouseCatalog(c.id, builder, { k8s }), /Not a warehouse/i);
});

test('discoverWarehouse: Glue offline (no live Trino) reports honestly, never invents tables', async () => {
  __resetConnections();
  const c = await glueConn();
  const res = await discoverWarehouse(c.id, builder, {});
  assert.equal(res.ok, false);
  assert.equal(res.mode, 'offline');
  assert.deepEqual(res.schemas, []);
  assert.match(res.detail, /not queryable yet/i);
});

test('discoverWarehouse: Fabric is honestly not-discoverable (no metastore)', async () => {
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
  const res = await discoverWarehouse(c.id, builder, { schema: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.detail, /not discoverable|no metastore/i);
});

test.after(() => {
  globalThis.fetch = _realFetch;
});
