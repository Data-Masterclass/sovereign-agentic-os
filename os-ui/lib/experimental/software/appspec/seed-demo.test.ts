/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * seed-demo.test — the GUARDED, IDEMPOTENT declarative demo-app seed.
 *
 *   • dataset PRESENT (seeded with the real Northpeak id + columns) → the app is created
 *     ONCE, its spec validates cleanly, serveMode flips to 'spec', and the dataset is granted.
 *   • a SECOND call → no-op (idempotent — the slug guard short-circuits, count stays 1).
 *   • dataset ABSENT → silently skips: no throw, and no app is created.
 *
 * Mirrors set-app-spec.test's offline setup: fail every OpenSearch/Forgejo fetch so both the
 * data + apps stores run purely in-process. Seeds the dataset via the test-only fixed-id door
 * (real datasets mint their own id; the seed guards on the literal `ds_zpco1s6n7y`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline: every network call rejects so the stores never touch OpenSearch/Forgejo.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, __seedDatasetForTest } = await import('../../data/store.ts');
const { __resetAppsCache, getAppBySlugInternal, serveModeOf, listAllAppsInternal } = await import('../apps.ts');
const { seedDeclarativeDemoApp } = await import('./seed-demo.ts');

const DATASET_ID = 'ds_zpco1s6n7y';
const OWNER = 'aborek';
const DOMAIN = 'agentic-leader-q3-2026';
const SLUG = 'northpeak-product-catalog-demo';

/** Seed the Northpeak Products dataset with its real id, owner, domain + real columns. */
function seedNorthpeak(): void {
  __seedDatasetForTest({
    id: DATASET_ID,
    name: 'Northpeak Products',
    owner: OWNER,
    domain: DOMAIN,
    tier: 'asset', // a governed domain asset → no Personal owner-only warning
    columns: [
      { name: 'product_id', description: 'PK' },
      { name: 'product_name', description: 'Display name' },
      { name: 'category', description: 'Category' },
      { name: 'brand', description: 'Brand' },
      { name: 'list_price_eur', description: 'List price (EUR)' },
    ],
  });
}

function reset(): void {
  __resetStore();
  __resetAppsCache();
}

test('seed: dataset present → creates the demo app once (spec validates, serveMode:spec, dataset granted)', async () => {
  reset();
  seedNorthpeak();

  await seedDeclarativeDemoApp();

  const app = await getAppBySlugInternal(SLUG);
  assert.ok(app, 'the demo app was created');
  assert.equal(app!.owner, OWNER);
  assert.equal(app!.domain, DOMAIN);
  assert.equal(app!.name, 'Northpeak Product Catalog (Demo)');
  // Declarative serving — validated spec persisted, serveMode flipped.
  assert.equal(serveModeOf(app!), 'spec');
  assert.ok(app!.spec, 'a spec was persisted');
  assert.equal(app!.spec!.tabs.length, 3);
  // The Northpeak dataset was granted (read) to the app.
  assert.deepEqual(
    app!.grants.data.map((g) => ({ id: g.id, access: g.access })),
    [{ id: DATASET_ID, access: 'read-only' }],
  );
});

test('seed: a second call is idempotent (no duplicate app)', async () => {
  reset();
  seedNorthpeak();

  await seedDeclarativeDemoApp();
  await seedDeclarativeDemoApp();

  const all = (await listAllAppsInternal()).filter((a) => a.slug === SLUG);
  assert.equal(all.length, 1, 'exactly one demo app exists after two seed calls');
});

test('seed: dataset absent → silently skips (no throw, no app)', async () => {
  reset();
  // No dataset seeded — the guard must short-circuit.

  await seedDeclarativeDemoApp(); // must not throw

  const app = await getAppBySlugInternal(SLUG);
  assert.equal(app, null, 'no app is created when the dataset is absent');
});
