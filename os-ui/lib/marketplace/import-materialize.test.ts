/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Import-materialisation tests — the Tier-1 fix. Proves the two import modes that
 * used to return a synthetic id now create REAL, owned objects the importer can
 * see in their own tab:
 *   • template        → a real BYO-credentials Connection (lib/connections.ts).
 *   • deploy-instance → a real owned artifact recording the instance + honest
 *                       (pending) deploy status (lib/artifacts.ts).
 * Governance gates stay intact (Builder+ to import, cross-domain only).
 *
 * Runs under `node --test`: fetch is stubbed offline so every registry falls back
 * to its in-process store, and `server-only` is neutralised by the test hook.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline-stub fetch BEFORE importing the server modules so every OpenSearch/
// Langfuse probe fails fast and each registry initialises its in-process store.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { importAdapter, myImports } = await import('./adapters.ts');
const { mockCatalog } = await import('./store.ts');
const { listConnectionsForUser } = await import('@/lib/connections');
const { listForUser } = await import('@/lib/artifacts');
import type { MockProduct } from './store.ts';
import type { Viewer } from './types.ts';

function pushProduct(p: Partial<MockProduct> & Pick<MockProduct, 'id' | 'type' | 'name'>): void {
  mockCatalog().push({
    description: 'A certified product for the import test.',
    owner: 'owner@sales',
    ownerDomain: 'sales',
    tags: ['test'],
    registry: 'os-registry',
    quality: 0.9,
    freshness: 0.9,
    accessPolicyOverride: 'open', // import lands immediately (no approval dance) so materialize runs inline
    ...p,
  });
}

const builder: Viewer = { id: 'bea', domains: ['marketing'], role: 'builder' };

test('TEMPLATE import creates a REAL Connection the importer owns (not a synthetic id)', async () => {
  pushProduct({ id: 'mkt_conn_test', type: 'connection', name: 'Salesforce link', previewSpec: { template: 'salesforce-api' } });

  const before = await listConnectionsForUser({ id: builder.id, name: builder.id, domains: builder.domains, role: 'builder' });
  const res = await importAdapter.import('mkt_conn_test', builder, 'template');

  assert.equal(res.pending, false, 'open access → active grant, materialised inline');
  assert.equal(res.grant.status, 'active');
  assert.ok(res.grant.derivedId, 'a derived id is returned');
  assert.ok(!res.grant.derivedId!.startsWith('conn_mkt_conn_test_'), 'not the old synthetic conn_<product>_<user> id');

  const after = await listConnectionsForUser({ id: builder.id, name: builder.id, domains: builder.domains, role: 'builder' });
  assert.equal(after.length, before.length + 1, 'exactly one new Connection appears for the importer');
  const conn = after.find((c) => c.id === res.grant.derivedId);
  assert.ok(conn, 'the derived id is a real Connection in the importer\'s Connections tab');
  assert.equal(conn!.owner, builder.id, 'owned by the importer');
  assert.equal(conn!.domain, 'marketing', 'created into the importer\'s domain');
  assert.equal(conn!.secretSet, false, 'BYO — no credential yet; importer adds it in Connections');
  assert.equal(conn!.template, 'salesforce-api', 'template resolved from the product spec');
});

test('DEPLOY-INSTANCE import creates a REAL owned artifact with an honest deploy status', async () => {
  pushProduct({ id: 'mkt_app_test', type: 'app', name: 'Ops console', ownerDomain: 'sales' });

  const before = await listForUser({ id: builder.id, name: builder.id, domains: builder.domains, role: 'builder' });
  const res = await importAdapter.import('mkt_app_test', builder, 'deploy-instance');

  assert.equal(res.grant.status, 'active');
  assert.ok(res.grant.derivedId, 'a derived id is returned');
  assert.ok(!res.grant.derivedId!.startsWith('instance_mkt_app_test_'), 'not the old synthetic instance_<product>_<user> id');

  const after = await listForUser({ id: builder.id, name: builder.id, domains: builder.domains, role: 'builder' });
  const art = after.find((a) => a.id === res.grant.derivedId);
  assert.ok(art, 'the derived id is a real owned artifact in the importer\'s workspace');
  assert.ok(after.length > before.length, 'a new artifact appears for the importer');
  assert.equal(art!.owner, builder.id, 'owned by the importer');
  assert.equal(art!.domain, 'marketing', 'created into the importer\'s domain');
  // HONESTY: the record does not pretend to be deployed.
  assert.equal(art!.spec?.deployStatus, 'pending-provision');
  assert.equal(art!.spec?.provisioned, false);
  assert.equal(art!.spec?.sourceProductId, 'mkt_app_test');
});

test('GOVERNANCE intact: a non-Builder (creator) cannot import — no object is materialised', async () => {
  pushProduct({ id: 'mkt_conn_gate', type: 'connection', name: 'Gated link' });
  const creator: Viewer = { id: 'cara', domains: ['marketing'], role: 'creator' };
  await assert.rejects(
    () => importAdapter.import('mkt_conn_gate', creator, 'template'),
    /Builder or Admin/,
  );
  assert.equal(myImports(creator).length, 0, 'no grant, nothing materialised');
});

// Restore the real fetch for any subsequent modules in this file.
test.after?.(() => { globalThis.fetch = _realFetch; });
