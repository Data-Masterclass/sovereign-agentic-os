/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * publish-app.test — the DRAFT/LIVE model (os-ui 0.6.135).
 *
 *   • saveAppDraft persists an INCOMPLETE draft (no serve-gate), never touching the live spec,
 *     and the app stays listed in the tiles — the disappearing-app bug's fix.
 *   • publishApp validates the draft with the FULL serving gate: an invalid draft is rejected
 *     (nothing promoted, live spec untouched) and a valid draft goes live + snapshots a version
 *     with a deterministic change summary.
 *   • BACKWARD-COMPAT: an app with only `spec` (no draftSpec) still serves + lists + publishes.
 *
 * Mirrors set-app-spec.test's offline seed harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, createDataset, buildVersion, setDocs, transition } = await import('../data/store.ts');
const {
  __resetAppsCache,
  createApp,
  patchAppDesign,
  saveAppDraft,
  publishApp,
  setAppSpec,
  listAppsForUser,
  listAppVersions,
  restoreAppVersion,
  getAppByIdInternal,
  getAppForUser,
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

function seedOrders(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  setDocs(d.id, amir, { columns: [{ name: 'order_id', description: 'PK' }, { name: 'net_amount', description: 'Money' }] });
  transition(d.id, amir, 'promote');
  return d.id;
}

function specWithColumns(datasetId: string, cols: string[], name = 'Orders App') {
  return {
    version: 2,
    name,
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId }, columns: cols.map((c) => ({ field: c })) } },
      },
    ],
  };
}

test('saveAppDraft: an INCOMPLETE draft persists without the serve gate; app stays listed', async () => {
  __resetStore();
  __resetAppsCache();
  const app = await createApp(user, { name: 'Draft App', domain: 'sales', kind: 'spec' });

  // A structurally-incomplete draft (no tabs) must still SAVE — the composer autosaves partials.
  await saveAppDraft(app.id, { version: 2, name: 'Draft App', description: 'wip' }, user);

  const reloaded = await getAppByIdInternal(app.id);
  assert.ok(reloaded!.draftSpec, 'the incomplete draft is persisted');
  assert.equal(reloaded!.spec, undefined, 'the live spec is NOT set by a draft save');

  // The tiles include an app that has only a draft (never hidden).
  const listed = await listAppsForUser(user);
  assert.ok(listed.some((a) => a.id === app.id), 'a draft-only app shows in the tiles');
});

test('saveAppDraft → getAppForUser: the autosaved draft ROUND-TRIPS through the READ path (the UI fetch)', async () => {
  // The data-loss regression (os-ui 0.6.138): the composer re-hydrates from the `draftSpec`
  // returned by GET /api/apps/[id] (→ getAppForUser). If that read path dropped the draft, a
  // full reload / re-open would lose the work. This asserts the draft survives the SAME read
  // door the app-detail page uses — so remounting the composer sees the autosaved work.
  __resetStore();
  __resetAppsCache();
  const app = await createApp(user, { name: 'Roundtrip App', domain: 'sales', kind: 'spec' });

  await saveAppDraft(app.id, { version: 2, name: 'Roundtrip App', description: 'wip', tabs: [] }, user);

  const read = await getAppForUser(app.id, user);
  assert.ok(read.draftSpec, 'getAppForUser returns the autosaved draftSpec');
  assert.equal(read.draftSpec!.description, 'wip', 'the draft content round-trips intact');
  assert.equal(read.spec, undefined, 'the live spec is untouched by a draft save');
});

test('publishApp: an INVALID draft is rejected — nothing goes live', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales', kind: 'spec' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id', 'not_a_column']), user);

  const res = await publishApp(app.id, user);
  assert.ok(res.issues.length > 0, 'an unknown column blocks publish');
  assert.equal(res.version, null, 'no version snapshot on a rejected publish');

  const reloaded = await getAppByIdInternal(app.id);
  assert.equal(reloaded!.spec, undefined, 'the live spec stays unset');
});

test('publishApp: a VALID draft goes live, clears the draft, and snapshots a version', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales', kind: 'spec' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id', 'net_amount']), user);

  const res = await publishApp(app.id, user);
  assert.deepEqual(res.issues, [], 'a valid draft has no issues');
  assert.ok(res.version, 'a version is snapshotted');
  assert.match(res.version!.summary, /v1/, 'the version name is v1');
  assert.match(res.version!.summary, /Initial publish/i, 'the first publish summary is honest');

  const reloaded = await getAppByIdInternal(app.id);
  assert.ok(reloaded!.spec, 'the spec is now live');
  assert.equal(reloaded!.draftSpec, undefined, 'the draft is cleared once promoted');
  assert.equal(serveModeOf(reloaded!), 'spec', 'serveMode is spec');

  const history = await listAppVersions(app.id, user);
  assert.equal(history.length, 1, 'one version in the history');
});

test('publishApp: a SECOND publish diffs against the previous live spec', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales', kind: 'spec' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id']), user);
  await publishApp(app.id, user);

  // Rename + publish again → the summary reports the rename against the previous live spec.
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id'], 'Renamed Orders'), user);
  const res2 = await publishApp(app.id, user);
  assert.match(res2.version!.summary, /v2/, 'the second version is v2');
  assert.match(res2.version!.summary, /renamed/i, 'the diff reports the rename');
});

test('restoreAppVersion: restores a published spec back to live', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Orders App', domain: 'sales', kind: 'spec' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id'], 'First'), user);
  await publishApp(app.id, user);
  await saveAppDraft(app.id, specWithColumns(dsId, ['order_id'], 'Second'), user);
  await publishApp(app.id, user);

  // Restore v1 (the "First" name) — it comes back live.
  const restored = await restoreAppVersion(app.id, user, 1);
  assert.equal(restored.spec!.name, 'First', 'the v1 spec is restored to live');
});

test('backward-compat: an app with only `spec` (no draftSpec) still serves + lists + publishes', async () => {
  __resetStore();
  __resetAppsCache();
  const dsId = seedOrders();
  const app = await createApp(user, { name: 'Legacy App', domain: 'sales', kind: 'spec' });
  await patchAppDesign(app.id, user, { grants: { ...app.grants, data: [{ id: dsId, access: 'read-only' }] } });

  // Simulate a legacy app: spec set directly via setAppSpec, NO draftSpec ever written.
  const set = await setAppSpec(app.id, specWithColumns(dsId, ['order_id', 'net_amount']), user);
  assert.deepEqual(set.issues, []);
  const before = await getAppByIdInternal(app.id);
  assert.ok(before!.spec, 'serves off `spec`');
  assert.equal(before!.draftSpec, undefined, 'no draft exists');

  // It still lists.
  const listed = await listAppsForUser(user);
  assert.ok(listed.some((a) => a.id === app.id), 'a spec-only app shows in the tiles');

  // Publish with no draftSpec falls back to the live spec (draft == live) and snapshots a version.
  const res = await publishApp(app.id, user);
  assert.deepEqual(res.issues, [], 'a spec-only app publishes cleanly');
  assert.ok(res.version, 'the fallback publish snapshots a version');
  const after = await getAppByIdInternal(app.id);
  assert.ok(after!.spec, 'the live spec is unchanged + still serving');
});

test.after(() => {
  globalThis.fetch = _realFetch;
});
