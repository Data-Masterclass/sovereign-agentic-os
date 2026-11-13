/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDqOverview, riskScore, type DqDatasetInput } from '@tabs/monitoring/lib/dq-overview';

function ds(id: string, latest: DqDatasetInput['latest']): DqDatasetInput {
  return { id, name: id, owner: 'amir', domain: 'sales', latest };
}

test('riskScore: failing > never-run > clean passing', () => {
  const failing = riskScore(ds('a', { ranAt: 't', badge: 'failing', healthScore: 60, openFailures: 2, freshnessLate: true }));
  const neverRun = riskScore(ds('b', null));
  const clean = riskScore(ds('c', { ranAt: 't', badge: 'passing', healthScore: 100, openFailures: 0, freshnessLate: false }));
  assert.ok(failing > neverRun, 'a real failure outranks unknown');
  assert.ok(neverRun > clean, 'never-run outranks a clean pass');
  assert.equal(clean, 0, 'a perfectly clean, fresh, passing dataset is zero risk');
});

test('buildDqOverview ranks riskiest first + rolls up domain health', () => {
  const overview = buildDqOverview([
    ds('products', { ranAt: 't1', badge: 'passing', healthScore: 99, openFailures: 0, freshnessLate: false }),
    ds('orders', { ranAt: 't2', badge: 'failing', healthScore: 72, openFailures: 1, freshnessLate: true }),
    ds('customers', { ranAt: 't3', badge: 'passing', healthScore: 88, openFailures: 0, freshnessLate: false }),
    ds('leads', null),
  ]);
  assert.equal(overview.rows[0].id, 'orders', 'the failing dataset ranks first');
  assert.equal(overview.rows.at(-1)!.id, 'products', 'the healthiest recedes to the bottom');
  assert.equal(overview.failing, 1);
  assert.equal(overview.openFailures, 1);
  assert.equal(overview.neverRun, 1);
  // Domain health = mean over the THREE scored datasets (99, 72, 88) — the never-run one
  // has no score, so it is honestly excluded, not counted as 0.
  assert.equal(overview.domainHealth, Math.round((99 + 72 + 88) / 3));
});

test('buildDqOverview: empty in ⇒ honest nulls, no fake green', () => {
  const overview = buildDqOverview([]);
  assert.equal(overview.rows.length, 0);
  assert.equal(overview.domainHealth, null);
  assert.equal(overview.failing, 0);
  assert.equal(overview.neverRun, 0);
});

test('a never-run row carries badge unknown + null score (never a fake pass)', () => {
  const overview = buildDqOverview([ds('leads', null)]);
  const row = overview.rows[0];
  assert.equal(row.badge, 'unknown');
  assert.equal(row.healthScore, null);
  assert.equal(row.ranAt, null);
});

/**
 * Review B2-review-M5: `DqRunRecord.source` existed since B2 but no surface read it, so a dbt test
 * Dagster executed and the OS's own ad-hoc probe looked identical. They are not: only the former
 * runs on every build and fails the pipeline.
 */
test('buildDqOverview carries WHO produced each verdict, and omits it when unknowable', () => {
  const overview = buildDqOverview([
    ds('dagster-row', { ranAt: 't', badge: 'passing', healthScore: 100, openFailures: 0, freshnessLate: false, source: 'dagster' }),
    ds('os-row', { ranAt: 't', badge: 'passing', healthScore: 100, openFailures: 0, freshnessLate: false, source: 'os' }),
    ds('legacy-row', { ranAt: 't', badge: 'passing', healthScore: 100, openFailures: 0, freshnessLate: false }),
    ds('never-run', null),
  ]);
  const by = new Map(overview.rows.map((r) => [r.id, r]));
  assert.equal(by.get('dagster-row')!.source, 'dagster');
  assert.equal(by.get('os-row')!.source, 'os');
  assert.equal(by.get('legacy-row')!.source, undefined, 'a pre-B2 record claims nothing');
  assert.equal(by.get('never-run')!.source, undefined);
});
