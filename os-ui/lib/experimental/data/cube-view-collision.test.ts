/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubeName, cubeViewName } from './metrics.ts';
import type { Dataset } from './types.ts';

/**
 * Regression for the 2026-09-23 Data-tab outage: a dataset with a FROZEN slug produced a
 * view whose name equalled its cube's name, so Cube refused to compile the ENTIRE schema
 * ("Found conflicting cube and view name") — /meta 500'd and every dataset build/promote
 * failed, not just the offending one.
 */
const base = (over: Partial<Dataset>): Dataset =>
  ({
    id: 'ds_1', name: 'Service Centers', owner: 'alex', domain: 'kiekert',
    measures: [], columns: [{ name: 'id' }, { name: 'name' }],
    cubeNamespaced: true, ...over,
  }) as unknown as Dataset;

test('frozen slug: the view name never equals the cube name', () => {
  const d = base({ slug: 'service_centers', name: 'service_centers' });
  assert.notEqual(cubeViewName(d), cubeName(d), 'cube and view must differ');
  assert.equal(cubeName(d), 'kiekert__service_centers');
  assert.equal(cubeViewName(d), 'kiekert__Service_Centers', 'title-cased, matching convention');
});

test('every real-world dataset that broke Cube now yields a distinct view name', () => {
  // The three models that took the whole schema down on 2026-09-23.
  const cases: Array<[string, string]> = [
    ['agentic_leader_q3_2026', 'service_centers'],
    ['agentic_leader_q3_2026', 'northpeak_customers_master'],
    ['kiekert', 'service_centers'],
  ];
  for (const [domain, slug] of cases) {
    const d = base({ domain, slug, name: slug });
    assert.notEqual(cubeViewName(d), cubeName(d), `${domain}__${slug}: cube and view must differ`);
    assert.match(cubeViewName(d), /^[A-Za-z0-9_]+$/, 'view must be a valid Cube identifier');
  }
});

test('datasets WITHOUT a frozen slug keep their exact existing view name (no churn)', () => {
  const d = base({ name: 'Kiekert Bestellungen', slug: undefined });
  assert.equal(cubeViewName(d), 'kiekert__Kiekert_Bestellungen');
  assert.notEqual(cubeViewName(d), cubeName(d));
});
