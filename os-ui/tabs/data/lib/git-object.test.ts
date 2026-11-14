/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The `dataset` git-object resolver — the paths, and the one answer for "not yours"
 * USER STORY: As a domain member I want a dataset's history to be ITS history (not the whole
 *             project's), and a dataset I may not see to answer exactly what a missing one does
 *             (checklist G3/G5/G7).
 * ARCHITECTURE: Pure + injected read. No repository, no store, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetPaths, resolveDatasetGitObject, GIT_OBJECT_KIND } from '@tabs/data/lib/git-object';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { GIT_OBJECT_KINDS } from '@core/infra/git-objects';

const USER = { id: 'u1', domains: ['sales'], role: 'creator' as const };
const DATASET = { id: 'ds_1', name: 'Orders Q3', owner: 'alex@example.com', domain: 'sales' } as unknown as Dataset;

test('G3: the kind string is one of the kernel’s kinds', () => {
  assert.ok((GIT_OBJECT_KINDS as readonly string[]).includes(GIT_OBJECT_KIND));
});

test('G3: the selectors are THIS dataset’s model files, in both lanes, and never a shared file', () => {
  const paths = datasetPaths(DATASET);
  assert.deepEqual(paths, [
    'models/bronze/bronze_orders_q3.sql',
    'models/personal/alex_example_com/bronze_orders_q3.sql',
    'models/silver/silver_orders_q3.sql',
    'models/personal/alex_example_com/silver_orders_q3.sql',
    'models/gold/gold_orders_q3.sql',
    'models/personal/alex_example_com/gold_orders_q3.sql',
  ]);
  // The two that would make one dataset's history everybody's: the project root and the shared
  // per-directory documentation.
  assert.ok(!paths.includes('models/'), 'a selector of `models/` would attribute every dataset’s commits to this one');
  assert.ok(!paths.some((p) => p.endsWith('schema.yml')), 'schema.yml documents every dataset in its directory');
});

test('G3: a FROZEN slug wins over the display name — a rename never moves the history', () => {
  const renamed = { ...DATASET, slug: 'orders_q3', name: 'Orders, Q3 (restated)' } as unknown as Dataset;
  assert.ok(datasetPaths(renamed).includes('models/gold/gold_orders_q3.sql'));
});

test('G3: a refused read and a missing dataset are ONE answer', () => {
  const forbidden = resolveDatasetGitObject(USER, 'ds_other', () => {
    const e = new Error('Not a member') as Error & { status: number };
    e.status = 403;
    throw e;
  });
  const missing = resolveDatasetGitObject(USER, 'ds_nope', () => {
    const e = new Error('No such dataset') as Error & { status: number };
    e.status = 404;
    throw e;
  });
  assert.equal(forbidden, null);
  assert.equal(missing, null);
  assert.deepEqual(forbidden, missing, 'an id must not be probeable for existence');
});

test('G3: a visible dataset resolves to its domain, its paths and its OS-Object trailer', () => {
  const loc = resolveDatasetGitObject(USER, 'ds_1', () => DATASET);
  assert.ok(loc);
  assert.equal(loc.domain, 'sales');
  assert.equal(loc.trailerId, 'ds_1', 'the dbt commit writes `OS-Object: <id> (<name>)`');
  assert.equal(loc.name, 'Orders Q3');
  assert.deepEqual(loc.paths, datasetPaths(DATASET));
});

test('G3: a dataset with no domain has no repository, so it is not located', () => {
  const loc = resolveDatasetGitObject(USER, 'ds_1', () => ({ ...DATASET, domain: '' }) as unknown as Dataset);
  assert.equal(loc, null);
});
