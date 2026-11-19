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

// Offline: fail every OpenSearch fetch so the store runs in-process (mirrors apps.test).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, createDataset, buildVersion, setDocs, defineMeasure, transition } = await import('@tabs/data/lib/store');
const {
  __resetAppsCache,
  createApp,
  patchAppDesign,
  setAppSpec,
  saveAppDraft,
  publishApp,
  getAppByIdInternal,
  serveModeOf,
} = await import('./apps.ts');
import type { Principal } from '@tabs/data/lib/store';
import type { CurrentUser } from '@core/kernel/auth';

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

// ───────── the owner's error: `metric must be an object / use { metricId }` (2026-11-19) ─────────

/**
 * Production 0.8.0, Software tab, stage 4 "Build app": the reasoning model wrote
 * `"metric": "<id>"` and the structural gate answered `metric must be an object / use { metricId }`,
 * and after three attempts the whole build failed. `appspec/normalise.ts` was written to fix that,
 * but it was wired into `parseGeneratedSpec` ONLY — so it protected `generate_app_spec` and left
 * the three doors that actually PERSIST a spec parsing raw. These cases pin all three.
 */
function kpiSpec(metric: unknown) {
  return {
    version: 2,
    name: 'Orders App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Revenue',
        body: { kind: 'pattern', pattern: 'kpi-overview', config: { cards: [{ label: 'Revenue', metric }] } },
      },
    ],
  };
}

/** Seed a granted metric on a granted dataset and return the app + the metric id. */
async function appWithMetric() {
  __resetStore();
  __resetAppsCache();
  const datasetId = seedOrders();
  defineMeasure(datasetId, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  const metricId = `${datasetId}.revenue`;
  const app = await createApp(user, { name: 'Metric app', template: 'sovereign-app', kind: 'spec' });
  await patchAppDesign(app.id, user, {
    grants: { connections: [], data: [{ id: datasetId, access: 'read-only' }], knowledge: [], files: [], metrics: [{ id: metricId, access: 'read-only' }] },
  });
  return { appId: app.id, metricId };
}

test('setAppSpec: a BARE metric id is read, not rejected — and the rewrite is reported', async () => {
  const { appId, metricId } = await appWithMetric();
  const res = await setAppSpec(appId, kpiSpec(metricId), user);
  assert.deepEqual(res.issues, [], `the owner's error is back: ${JSON.stringify(res.issues)}`);
  assert.ok(
    res.warnings.some((w) => /normalised metric id/i.test(w.reason)),
    'the author is TOLD what was tidied up — a coercion is never invisible',
  );
  // TOLERANT PARSE, STRICT OUTPUT: what persists is canonical.
  const stored = await getAppByIdInternal(appId);
  const cards = (stored?.spec?.tabs?.[0] as { body: { config: { cards: { metric: unknown }[] } } }).body.config.cards;
  assert.deepEqual(cards[0].metric, { metricId });
});

test('setAppSpec: the generic `{ id }` key is RENAMED to { metricId }, inventing nothing', async () => {
  const { appId, metricId } = await appWithMetric();
  const res = await setAppSpec(appId, kpiSpec({ id: metricId }), user);
  assert.deepEqual(res.issues, [], JSON.stringify(res.issues));
  const stored = await getAppByIdInternal(appId);
  const cards = (stored?.spec?.tabs?.[0] as { body: { config: { cards: { metric: unknown }[] } } }).body.config.cards;
  assert.deepEqual(cards[0].metric, { metricId });
});

test('publishApp + saveAppDraft: the OTHER two spec doors normalise identically', async () => {
  const { appId, metricId } = await appWithMetric();
  await saveAppDraft(appId, kpiSpec(metricId), user);
  const res = await publishApp(appId, user);
  assert.deepEqual(res.issues, [], `publish rejected a readable draft: ${JSON.stringify(res.issues)}`);
  const cards = (res.app.spec?.tabs?.[0] as { body: { config: { cards: { metric: unknown }[] } } }).body.config.cards;
  assert.deepEqual(cards[0].metric, { metricId }, 'the published spec is canonical');
});

test('setAppSpec: an AMBIGUOUS shape is still refused — the gate is loosened for nothing', async () => {
  const { appId } = await appWithMetric();
  // `dataset` needs {datasetId, agg} — a bare id alone would have to invent the aggregation.
  const res = await setAppSpec(
    appId,
    {
      version: 2,
      name: 'Orders App',
      description: 'x',
      tabs: [
        {
          id: 't1',
          label: 'Revenue',
          body: { kind: 'pattern', pattern: 'kpi-overview', config: { cards: [{ label: 'Revenue', dataset: 'ds_whatever' }] } },
        },
      ],
    },
    user,
  );
  assert.ok(res.issues.length > 0, 'a shape the OS cannot unambiguously read is STILL a blocking issue');
  assert.ok(res.issues.every((i) => i.reason && i.fix), 'and it is machine-actionable');
});
