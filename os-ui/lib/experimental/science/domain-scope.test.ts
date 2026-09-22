/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/science/model-service.ts → listModelsForUser.
 * Every tier (Personal/Domain/Marketplace=Company) narrows to the viewer's active
 * domain. A model created in domain A is hidden when domain B is active, shown when
 * A is active, shown under "All Domains". Cross-domain discovery is the Marketplace's job.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  _resetModels,
  createModel,
  promoteModel,
  certifyModel,
  listModelsForUser,
  type Actor,
} from './model-service.ts';

// actor.domains[0] stamps the model's domain → 'sales' here.
const admin: Actor = { id: 'u1', role: 'admin', domains: ['sales'], isAgent: false };

const spec = () => ({
  sourceDataProductFqn: 'sales.customer_360',
  targetColumn: 'churned',
  taskType: 'binary_classification' as const,
  algorithm: 'logistic',
  features: ['recency_days'],
  trainTestSplit: 0.8,
  optimizeMetric: 'auc',
});

beforeEach(() => _resetModels());

function seedSales(tier: 0 | 1 | 2): string {
  const m = createModel({ name: `M-${tier}`, spec: spec() }, admin); // Personal, sales
  if (tier >= 1) promoteModel(m.model, admin); // → Domain
  if (tier >= 2) certifyModel(m.model, admin, 'read-in-place'); // → Marketplace (Company)
  return m.model;
}

function has(domains: string[], model: string) {
  return listModelsForUser({ id: 'u1', domains }).some((m) => m.model === model);
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`${label} model in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const model = seedSales(tier);
    assert.ok(!has(['finance'], model), `${label} sales model HIDDEN in finance`);
    assert.ok(has(['sales'], model), `${label} sales model SHOWN in sales`);
    assert.ok(has(['sales', 'finance'], model), `${label} sales model SHOWN under All Domains`);
  });
}
