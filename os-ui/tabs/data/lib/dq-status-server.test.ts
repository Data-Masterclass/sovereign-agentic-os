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
import { alertOnNewFailure, checkToResult, checksToRecord, latestDqRun, type DqDataset } from '@tabs/data/lib/dq-status-server';
import { __resetDqAlerts } from '@tabs/data/lib/dq-alert-state';
import type { deliverDqAlert } from '@core/notifications/dq-alert';
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

/* ------------------------------------------------- the owner is told (B4 review L-2) -- */

test('a Dagster record that transitions INTO failing alerts the owner exactly once (review L-2)', async () => {
  __resetDqAlerts();
  const sent: { name: string; to: string; failing: string[]; score: number | null }[] = [];
  const deps = {
    alert: ((input, recipient) => {
      sent.push({ name: input.datasetName, to: recipient.userId, failing: input.failingLabels, score: input.healthScore });
      return { channel: 'in_app' as const, delivered: true, to: recipient.userId, notificationId: 'n1' };
    }) as typeof deliverDqAlert,
    ownerOf: async () => ({ owner: 'amir', name: 'Orders' }),
    now: () => '2026-11-13T12:00:00.000Z',
  };
  const failing = {
    id: 'ds_x:2026-11-13T11:00:00.000Z', datasetId: 'ds_x', ranAt: '2026-11-13T11:00:00.000Z',
    badge: 'failing' as const, healthScore: 40,
    results: [{ id: 'not_null_order_id', label: 'not_null(order_id)', status: 'fail' as const, violations: 3 }],
    ranBy: 'run_1', domain: 'sales', rowCount: null, schemaFingerprint: null, source: 'dagster' as const,
  };
  assert.equal(await alertOnNewFailure(failing, deps), 'alerted');
  assert.deepEqual(sent, [{ name: 'Orders', to: 'amir', failing: ['not_null(order_id)'], score: 40 }]);

  // The SAME execution, read again (a second page view): suppressed.
  assert.equal(await alertOnNewFailure(failing, deps), 'suppressed');
  // A LATER execution that is still failing: suppressed too — one notification per incident.
  assert.equal(await alertOnNewFailure({ ...failing, ranAt: '2026-11-13T12:00:00.000Z' }, deps), 'suppressed');
  assert.equal(sent.length, 1, 'the owner is told once, not once per read');
});

test('a recovery re-arms the alert, and the OS probe never alerts (review L-2)', async () => {
  __resetDqAlerts();
  let count = 0;
  const deps = {
    alert: ((_i, r) => { count++; return { channel: 'in_app' as const, delivered: true, to: r.userId }; }) as typeof deliverDqAlert,
    ownerOf: async () => ({ owner: 'amir', name: 'Orders' }),
  };
  const base = {
    id: 'ds_y:a', datasetId: 'ds_y', ranAt: 'a', badge: 'failing' as const, healthScore: 10,
    results: [{ id: 'r', label: 'unique(id)', status: 'fail' as const, violations: 1 }],
    ranBy: 'run', domain: 'sales', rowCount: null, schemaFingerprint: null, source: 'dagster' as const,
  };
  assert.equal(await alertOnNewFailure(base, deps), 'alerted');
  assert.equal(await alertOnNewFailure({ ...base, ranAt: 'b', badge: 'passing', results: [{ id: 'r', label: 'unique(id)', status: 'pass', violations: 0 }] }, deps), 'suppressed');
  assert.equal(await alertOnNewFailure({ ...base, ranAt: 'c' }, deps), 'alerted', 'the next incident after a recovery fires again');
  assert.equal(count, 2);

  // The OS's own ad-hoc probe is something a person just pressed and is reading — never an alert.
  assert.equal(await alertOnNewFailure({ ...base, ranAt: 'd', source: 'os' }, deps), 'skipped');
  assert.equal(await alertOnNewFailure(null, deps), 'skipped');
  assert.equal(count, 2);
});

test('a failing dataset with no resolvable owner is logged, not retried forever (review L-2)', async () => {
  __resetDqAlerts();
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    const out = await alertOnNewFailure(
      {
        id: 'ds_z:a', datasetId: 'ds_z', ranAt: 'a', badge: 'failing', healthScore: null,
        results: [], ranBy: 'run', domain: 'sales', rowCount: null, schemaFingerprint: null, source: 'dagster',
      },
      { alert: (() => assert.fail('must not deliver')) as unknown as typeof deliverDqAlert, ownerOf: async () => null },
    );
    assert.equal(out, 'skipped');
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warns.some((w) => w.includes('ds_z') && w.includes('no resolvable owner')));
});
