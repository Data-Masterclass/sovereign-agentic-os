/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * set-app-spec.test — the ONE write door for `app.spec` (AppSpec Phase 3).
 *
 *   • an INVALID spec (unknown column) → issues returned, spec NOT persisted, serveMode
 *     stays 'image' (the app is left exactly as it was).
 *   • a VALID spec (granted dataset + real columns) → persisted, `serveMode` flips to 'spec',
 *     and the spec round-trips on a fresh read.
 *
 * Seeds a Gold dataset via the public data-store API (as validate.test does), creates a real
 * app via `createApp`, grants the dataset to it, then drives `setAppSpec`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline: fail every OpenSearch/Forgejo fetch so the store runs in-process (mirrors apps.test).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, createDataset, buildVersion, setDocs, transition } = await import('../data/store.ts');
const {
  __resetAppsCache,
  createApp,
  patchAppDesign,
  setAppSpec,
  getAppByIdInternal,
  serveModeOf,
} = await import('./apps.ts');
import type { Principal } from '../data/store.ts';
import type { CurrentUser } from '../core/auth.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };
const user: CurrentUser = {
  id: 'amir',
  name: 'Amir',
  domains: ['sales'],
  allDomains: ['sales'],
  activeDomain: 'sales',
  role: 'builder',
};

/** Gold "Orders" dataset with documented columns, promoted to Domain (no Personal warning). */
function seedOrders(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  setDocs(d.id, amir, {
    columns: [
      { name: 'order_id', description: 'PK' },
      { name: 'net_amount', description: 'Money' },
    ],
  });
  transition(d.id, amir, 'promote');
  return d.id;
}

function specWithColumns(datasetId: string, cols: string[]) {
  return {
    version: 2,
    name: 'Orders App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: { source: { datasetId }, columns: cols.map((c) => ({ field: c })) },
        },
      },
    ],
  };
}

test('setAppSpec: an INVALID spec is rejected with issues and NOT persisted', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });

  const res = await setAppSpec(app.id, specWithColumns(dsId, ['order_id', 'not_a_column']), user);

  assert.ok(res.issues.length > 0, 'an unknown column must produce a blocking issue');
  assert.ok(res.issues.some((i) => /not_a_column/.test(i.reason)), 'issue names the bad column');

  const reloaded = await getAppByIdInternal(app.id);
  assert.equal(reloaded!.spec, undefined, 'spec is NOT persisted on a blocking issue');
  assert.equal(serveModeOf(reloaded!), 'image', 'serveMode stays image');
});

test('setAppSpec: a VALID spec persists and flips serveMode to spec', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });

  const res = await setAppSpec(app.id, specWithColumns(dsId, ['order_id', 'net_amount']), user);

  assert.deepEqual(res.issues, [], 'a granted dataset with real columns has no issues');
  assert.equal(serveModeOf(res.app), 'spec', 'serveMode flips to spec');
  // 0.6.136: a governed author = a versioned publish — the snapshot is returned.
  assert.ok(res.version, 'setAppSpec snapshots a version (author = versioned publish)');
  assert.match(res.version!.summary ?? '', /^v1/, 'the version carries the auto v{n} name');

  const reloaded = await getAppByIdInternal(app.id);
  assert.ok(reloaded!.spec, 'spec is persisted');
  assert.equal(reloaded!.spec!.tabs.length, 1, 'the spec round-trips');
  assert.equal(serveModeOf(reloaded!), 'spec', 'persisted serveMode is spec');
});

test('setAppSpec: a structurally malformed payload returns parse issues, unpersisted', async () => {
  __resetStore();
  __resetAppsCache();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales' });

  const res = await setAppSpec(app.id, { version: 2, name: 'x' }, user); // no tabs/description
  assert.ok(res.issues.length > 0, 'malformed payload → issues');

  const reloaded = await getAppByIdInternal(app.id);
  assert.equal(reloaded!.spec, undefined, 'nothing persisted');
  assert.equal(serveModeOf(reloaded!), 'image', 'serveMode untouched');
});
