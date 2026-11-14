/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The `metric` git-object resolver — the three facts, obtained through the GOVERNED read
 * USER STORY: As any user I want a KPI's history to resolve from its semantic YAML in the right
 *             domain and the right lane, and a KPI I may not see to answer what a missing one
 *             answers (checklist G3/G5/G7).
 * ARCHITECTURE: The read is injected, so this measures the facts and the gating without a store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricGitFacts } from '@tabs/metrics/lib/git-object-server';
import { metricGitLocation, domainLanePath, personalLanePath } from '@tabs/metrics/lib/git-object';
import { semanticModelName, laneUid } from '@tabs/metrics/lib/model';

const USER = { id: 'u1', domains: ['sales'], role: 'creator' };
const RECORD = {
  dataset: { id: 'ds_1', name: 'Orders Q3', owner: 'alex@example.com', domain: 'sales' },
  measure: { name: 'revenue' },
};

test('G3: the facts come off the record the governed read returned — domain, model, lane uid', () => {
  const facts = metricGitFacts(USER, 'ds_1.revenue', () => RECORD);
  assert.ok(facts);
  assert.equal(facts.domain, 'sales');
  assert.equal(facts.semanticModel, semanticModelName(RECORD.dataset as Parameters<typeof semanticModelName>[0]));
  assert.equal(facts.ownerUid, laneUid('alex@example.com'));
  assert.match(facts.name ?? '', /Orders Q3/);
});

test('G3: a refused metric and a missing metric are ONE answer', () => {
  const refused = metricGitFacts(USER, 'ds_x.m', () => {
    throw Object.assign(new Error('metric not found'), { status: 404 });
  });
  const forbidden = metricGitFacts(USER, 'ds_y.m', () => {
    throw Object.assign(new Error('Not a member'), { status: 403 });
  });
  assert.equal(refused, null);
  assert.deepEqual(refused, forbidden, 'an id must not be probeable for existence');
});

test('G3: a metric on a dataset with no domain is not located', () => {
  assert.equal(metricGitFacts(USER, 'ds_1.revenue', () => ({ ...RECORD, dataset: { ...RECORD.dataset, domain: '' } })), null);
});

test('G3: the location carries BOTH lanes, so a promoted metric keeps its earlier history', () => {
  const facts = metricGitFacts(USER, 'ds_1.revenue', () => RECORD)!;
  const loc = metricGitLocation('ds_1.revenue', facts);
  assert.deepEqual(loc.paths, [domainLanePath(facts.semanticModel), personalLanePath(facts.ownerUid, facts.semanticModel)]);
  assert.equal(loc.trailerId, 'metric:ds_1.revenue', 'the dbt commit stamps `OS-Object: metric:<datasetId>.<measure>`');
  assert.equal(loc.domain, 'sales');
});
