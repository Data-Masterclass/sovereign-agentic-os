/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelName, viewName } from '@tabs/data/lib/metrics';
import type { Dataset } from '@tabs/data/lib/types';

/**
 * Regression for the 2026-09-23 Data-tab outage: a dataset with a FROZEN slug produced a
 * view whose name equalled its MODEL name. The two are distinct identities in one
 * namespace — collapsing them made the whole dataset registry ambiguous and took every
 * dataset's build/promote down, not just the offending one. The guard is kept (and the
 * identities stay frozen) so no stored dashboard/metric member is ever repointed.
 */
const base = (over: Partial<Dataset>): Dataset =>
  ({
    id: 'ds_1', name: 'Service Centers', owner: 'alex', domain: 'kiekert',
    measures: [], columns: [{ name: 'id' }, { name: 'name' }],
    viewNamespaced: true, ...over,
  }) as unknown as Dataset;

test('frozen slug: the view name never equals the model name', () => {
  const d = base({ slug: 'service_centers', name: 'service_centers' });
  assert.notEqual(viewName(d), modelName(d), 'model and view must differ');
  assert.equal(modelName(d), 'kiekert__service_centers');
  assert.equal(viewName(d), 'kiekert__Service_Centers', 'title-cased, matching convention');
});

test('every real-world dataset that broke Model now yields a distinct view name', () => {
  // The three models that took the whole schema down on 2026-09-23.
  const cases: Array<[string, string]> = [
    ['agentic_leader_q3_2026', 'service_centers'],
    ['agentic_leader_q3_2026', 'northpeak_customers_master'],
    ['kiekert', 'service_centers'],
  ];
  for (const [domain, slug] of cases) {
    const d = base({ domain, slug, name: slug });
    assert.notEqual(viewName(d), modelName(d), `${domain}__${slug}: model and view must differ`);
    assert.match(viewName(d), /^[A-Za-z0-9_]+$/, 'view must be a valid Model identifier');
  }
});

test('datasets WITHOUT a frozen slug keep their exact existing view name (no churn)', () => {
  const d = base({ name: 'Kiekert Bestellungen', slug: undefined });
  assert.equal(viewName(d), 'kiekert__Kiekert_Bestellungen');
  assert.notEqual(viewName(d), modelName(d));
});
