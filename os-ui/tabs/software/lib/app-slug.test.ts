/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An app's slug is unique within its domain, and a rename never moves its tree (M-3)
 * USER STORY: Two apps called "Invoices" in one domain must not share — and overwrite — one
 *             source tree in the domain repository. And renaming an app must not orphan or
 *             duplicate its tree.
 * ARCHITECTURE: The collision rule is a pure function, tested directly; the store-level behaviour
 *             is then driven through the real `createApp`/`renameApp` offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp, renameApp, uniqueAppSlug } = await import('./apps.ts');
const { appSubtreePrefix } = await import('./git-commit.ts');

const dev: CurrentUser = testUser({ id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' });
const other: CurrentUser = testUser({ id: 'sam', name: 'Sam', domains: ['sales'], role: 'builder' });

test('uniqueAppSlug: the first wins the bare slug, the rest are suffixed', () => {
  assert.equal(uniqueAppSlug('Invoices', []), 'invoices');
  assert.equal(uniqueAppSlug('Invoices', ['invoices']), 'invoices-2');
  assert.equal(uniqueAppSlug('Invoices', ['invoices', 'invoices-2']), 'invoices-3');
  assert.equal(uniqueAppSlug('Invoices', ['INVOICES']), 'invoices-2', 'the comparison is case-insensitive');
  // The result is always a legal single path segment for the git store.
  for (const taken of [[], ['invoices'], ['invoices', 'invoices-2']]) {
    assert.doesNotThrow(() => appSubtreePrefix(uniqueAppSlug('Invoices', taken)));
  }
  const long = 'x'.repeat(60);
  const s = uniqueAppSlug(long, [long.slice(0, 48)]);
  assert.ok(s.length <= 48, 'the suffix never pushes it past the segment cap');
  assert.doesNotThrow(() => appSubtreePrefix(s));
});

test('createApp: a second app with the SAME name in the SAME domain gets its own tree', async () => {
  const a = await createApp(dev, { name: 'Invoices', template: 'sovereign-app' });
  const b = await createApp(dev, { name: 'Invoices', template: 'sovereign-app' });
  assert.notEqual(a.slug, b.slug, 'the slugs differ');
  assert.notEqual(appSubtreePrefix(a.slug), appSubtreePrefix(b.slug), 'so the SOURCE TREES differ');
  assert.equal(a.slug, 'invoices');
  assert.equal(b.slug, 'invoices-2');
  // The per-app host follows the slug, so it stays unique too.
  assert.notEqual(a.subdomain, b.subdomain);
});

test('createApp: the same name in ANOTHER domain keeps the bare slug — one repo per domain', async () => {
  const mine = await createApp(dev, { name: 'Reports', template: 'sovereign-app' });
  const theirs = await createApp(other, { name: 'Reports', template: 'sovereign-app' });
  assert.equal(mine.slug, 'reports');
  assert.equal(theirs.slug, 'reports', 'a different domain is a different repository — no collision');
  assert.notEqual(mine.domain, theirs.domain);
});

test('renameApp: the slug — and therefore the source tree path — NEVER moves', async () => {
  const app = await createApp(dev, { name: 'Before Rename', template: 'sovereign-app' });
  const before = appSubtreePrefix(app.slug);
  const renamed = await renameApp(app.id, dev, 'After Rename');
  assert.equal(renamed.name, 'After Rename');
  assert.equal(renamed.slug, app.slug, 'the frozen physical identity is untouched');
  assert.equal(appSubtreePrefix(renamed.slug), before, 'so there is no old prefix to delete');
  assert.equal(renamed.subdomain, app.subdomain);
  globalThis.fetch = _realFetch;
});
