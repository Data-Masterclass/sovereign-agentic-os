/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Quality read-back — Dagster asset checks (one per dbt test) mapped to the OS's shape
 * USER STORY: As a maintainer I want proof that a FAILED dbt test becomes a failing OS check row
 *             carrying dagster-dbt's failed-row count, that a check which never executed is
 *             `not_run` and never a green, that a Dagster outage yields no record rather than a
 *             fake one, and that a Dagster record always says `source: 'dagster'`.
 * ARCHITECTURE: pure mappers plus an injected `assetChecks`; no network, no store snapshot.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import { checkToResult, checksToRecord, latestDqRun, type DqDataset } from '@tabs/data/lib/dq-status-server';
import type { AssetCheck } from '@core/infra/dagster';

afterEach(() => __setDataProjectGitForTests(null));

const d: DqDataset = { id: 'ds_1', domain: 'sales' };

function check(over: Partial<AssetCheck> = {}): AssetCheck {
  return {
    name: 'not_null_silver_orders_order_id',
    description: 'dbt test',
    latest: { status: 'SUCCEEDED', runId: 'r1', at: '2026-11-13T06:01:00.000Z', severity: null, description: null, metadata: {} },
    ...over,
  };
}

test('a dbt test maps 1:1: pass, fail with the failed-row count, never-executed, other statuses', () => {
  assert.deepEqual(checkToResult(check()), { id: 'not_null_silver_orders_order_id', label: 'not_null_silver_orders_order_id', status: 'pass', violations: 0 });
  const failed = checkToResult(check({ latest: { status: 'FAILED', runId: 'r1', at: 'x', severity: 'ERROR', description: '3 rows', metadata: { 'dagster_dbt/failed_row_count': 3 } } }));
  assert.deepEqual(failed, { id: 'not_null_silver_orders_order_id', label: 'not_null_silver_orders_order_id', status: 'fail', violations: 3 });
  const unknownCount = checkToResult(check({ latest: { status: 'FAILED', runId: 'r1', at: 'x', severity: null, description: null, metadata: {} } }));
  assert.equal(unknownCount.violations, null, 'an unknown count is null, never 0');
  const never = checkToResult(check({ latest: null }));
  assert.deepEqual(never.status, 'not_run');
  assert.match(never.reason!, /not executed yet/);
  const skipped = checkToResult(check({ latest: { status: 'SKIPPED', runId: null, at: null, severity: null, description: null, metadata: {} } }));
  assert.equal(skipped.status, 'not_run');
});

test('checksToRecord: the newest execution time, the aggregate badge, source dagster; no execution ⇒ null', () => {
  const rec = checksToRecord(d, [
    check({ name: 'a', latest: { status: 'SUCCEEDED', runId: 'r1', at: '2026-11-13T06:00:00.000Z', severity: null, description: null, metadata: {} } }),
    check({ name: 'b', latest: { status: 'FAILED', runId: 'r2', at: '2026-11-13T07:00:00.000Z', severity: 'ERROR', description: null, metadata: { 'dagster_dbt/failed_row_count': 2 } } }),
    check({ name: 'c', latest: null }),
  ])!;
  assert.equal(rec.ranAt, '2026-11-13T07:00:00.000Z');
  assert.equal(rec.datasetId, 'ds_1');
  assert.equal(rec.domain, 'sales');
  assert.equal(rec.source, 'dagster');
  assert.equal(rec.badge, 'failing');
  assert.equal(rec.results.length, 3);
  assert.equal(rec.rowCount, null, 'volume is a Dagster asset check, not a dbt test (concept §1)');
  assert.equal(checksToRecord(d, [check({ latest: null })]), null);
  assert.equal(checksToRecord(d, []), null);
});

test('flag ON: a Dagster outage yields no fabricated record; flag OFF never calls Dagster', async () => {
  __setDataProjectGitForTests(true);
  let called = 0;
  const down = { assetChecks: async () => { called++; return { ok: false as const, error: 'HTTP 503' }; }, allAssetChecks: async () => ({ ok: false as const, error: 'HTTP 503' }) };
  // No repo snapshot for this domain in the test store ⇒ no tested asset ⇒ the OS fallback (none here).
  assert.equal(await latestDqRun(d, { dagster: down }), null);

  __setDataProjectGitForTests(false);
  called = 0;
  assert.equal(await latestDqRun(d, { dagster: down }), null);
  assert.equal(called, 0, 'the flag-off path reads the OS ledger only');
});
