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
import { alertOnNewFailure, readbackAllDq, checkToResult, checksToRecord, latestDqRun, type DqDataset } from '@tabs/data/lib/dq-status-server';
import { __resetDqAlerts } from '@tabs/data/lib/dq-alert-state';
import type { deliverDqAlert } from '@core/notifications/dq-alert';
import type { AssetCheck } from '@core/infra/dagster';

afterEach(() => __setDataProjectGitForTests(null));

const d: DqDataset = { id: 'ds_1', domain: 'sales' };

/** An in-memory stand-in for the shared claim store: first claimant of a key wins (one per test). */
function newClaim() {
  const taken = new Set<string>();
  return async (k: { datasetId: string; rule: string; ranAt: string }) => {
    const id = JSON.stringify([k.datasetId, k.rule, k.ranAt]);
    if (taken.has(id)) return 'lost' as const;
    taken.add(id);
    return 'won' as const;
  };
}

function check(over: Partial<AssetCheck> = {}): AssetCheck {
  return {
    name: 'not_null_silver_orders_order_id',
    description: 'dbt test',
    latest: { status: 'SUCCEEDED', runId: 'r1', at: '2026-11-13T06:01:00.000Z', severity: null, description: null, metadata: {} },
    ...over,
  };
}

test('a dbt test maps 1:1: pass, fail with the failed-row count, never-executed, other statuses', () => {
  assert.deepEqual(checkToResult(check()), { id: 'not_null_silver_orders_order_id', label: 'not_null_silver_orders_order_id', status: 'pass', violations: 0, at: '2026-11-13T06:01:00.000Z' });
  const failed = checkToResult(check({ latest: { status: 'FAILED', runId: 'r1', at: 'x', severity: 'ERROR', description: '3 rows', metadata: { 'dagster_dbt/failed_row_count': 3 } } }));
  assert.deepEqual(failed, { id: 'not_null_silver_orders_order_id', label: 'not_null_silver_orders_order_id', status: 'fail', violations: 3, severity: 'error', at: 'x' });
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
    claim: newClaim(),
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
    claim: newClaim(),
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

test('a dbt test with severity warn that found rows is a WARN, not a fail; severity and time ride along (ownership rule: dbt decides)', () => {
  const warn = checkToResult(check({ latest: { status: 'FAILED', runId: 'r1', at: '2026-11-13T06:01:00.000Z', severity: 'WARN', description: '2 rows', metadata: { 'dagster_dbt/failed_row_count': 2 } } }));
  assert.deepEqual(warn, { id: 'not_null_silver_orders_order_id', label: 'not_null_silver_orders_order_id', status: 'warn', violations: 2, severity: 'warn', at: '2026-11-13T06:01:00.000Z' });
  // twin: the same execution with severity ERROR is a fail
  assert.equal(checkToResult(check({ latest: { status: 'FAILED', runId: 'r1', at: 'x', severity: 'ERROR', description: null, metadata: { 'dagster_dbt/failed_row_count': 2 } } })).status, 'fail');
});

test('a warn alone does not make the dataset failing, and a warn is not a perfect score', () => {
  const rec = checksToRecord(d, [
    check({ name: 'a' }),
    check({ name: 'w', latest: { status: 'FAILED', runId: 'r1', at: '2026-11-13T06:01:00.000Z', severity: 'WARN', description: null, metadata: { 'dagster_dbt/failed_row_count': 1 } } }),
  ])!;
  assert.equal(rec.badge, 'passing');
  assert.ok(rec.healthScore !== null && rec.healthScore <= 99, 'a warn must not round up to 100');
  // twin: add an error-severity failure and the badge is failing
  const bad = checksToRecord(d, [check({ name: 'a' }), check({ name: 'f', latest: { status: 'FAILED', runId: 'r1', at: 'x', severity: 'ERROR', description: null, metadata: {} } })])!;
  assert.equal(bad.badge, 'failing');
});

test('the periodic read-back tells the owner of a failing scheduled run with NO page read, and stays quiet when nothing failed', async () => {
  __resetDqAlerts();
  __setDataProjectGitForTests(true);
  const sent: string[] = [];
  const failing = (id: string) => ({
    id: `${id}:a`, datasetId: id, ranAt: 'a', badge: 'failing' as const, healthScore: 10,
    results: [{ id: 'r', label: 'not_null(x)', status: 'fail' as const, violations: 1 }],
    ranBy: 'run', domain: 'sales', rowCount: null, schemaFingerprint: null, source: 'dagster' as const,
  });
  const deps = {
    claim: newClaim(),
    alert: ((i: { datasetName: string }) => { sent.push(i.datasetName); return { channel: 'in_app' as const, delivered: true, to: 'amir' }; }) as unknown as typeof deliverDqAlert,
    ownerOf: async (id: string) => ({ owner: 'amir', name: id }),
    latestRuns: async (ds: DqDataset[]) => new Map([...new Map([['ds_bad', failing('ds_bad')], ['ds_ok', { ...failing('ds_ok'), badge: 'passing' as const, results: [{ id: 'r', label: 'x', status: 'pass' as const, violations: 0 }] }]])].filter(([id]) => ds.some((d) => d.id === id))),
  };
  const r = await readbackAllDq([{ id: 'ds_bad', domain: 'sales' }, { id: 'ds_ok', domain: 'sales' }], deps);
  assert.deepEqual(sent, ['ds_bad']);
  assert.deepEqual(r, { read: 2, alerted: 1, unavailable: 0 });
  // twin: a second pass over the same execution does not tell the owner again
  assert.deepEqual(await readbackAllDq([{ id: 'ds_bad', domain: 'sales' }], deps), { read: 1, alerted: 0, unavailable: 0 });
});

test('the REAL Dagster payload of a failed dbt not_null test (captured from lakehouse.sh: dagster-dbt 0.29.31 on Trino) maps to a fail with 1 row, error severity and its time', async () => {
  const { readFileSync } = await import('node:fs');
  const payload = readFileSync(new URL('./fixtures/dagster-dq-failed-real.json', import.meta.url), 'utf8');
  const f = (async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const { allAssetChecks } = await import('@core/infra/dagster');
  const all = await allAssetChecks({ fetch: f, url: 'http://dagster' });
  assert.ok(all.ok);
  const checks = (all as { ok: true; data: Record<string, AssetCheck[]> }).data['sales/personal_alice/gold_shop_orders'];
  assert.equal(checks.length, 1);
  assert.deepEqual(checkToResult(checks[0]), {
    id: 'not_null_gold_shop_orders_customer', label: 'not_null_gold_shop_orders_customer', status: 'fail', violations: 1, severity: 'error', at: new Date(1795335615 * 1000).toISOString(), // the check execution's own timestamp, in seconds
  });
});

/* ------------------------------ owner rule: Dagster unreachable ⇒ unavailable, never stale-as-live -- */

import { recordRun, __resetDqResults } from '@tabs/data/lib/dq-results';
import { dqTrend, readDqRuns, latestDqRuns } from '@tabs/data/lib/dq-status-server';
import * as srv from '@tabs/data/lib/dq-status-server';
const readbackWarning = (): string | null => {
  const f = (srv as unknown as { readbackWarning?: () => string | null }).readbackWarning;
  return f ? f() : 'MISSING readbackWarning export';
};

const LEDGER_AT = '2026-11-01T08:00:00.000Z';
const tested = async () => ['sales', 'gold_orders'];
const down = { assetChecks: async () => ({ ok: false as const, error: 'HTTP 503' }), allAssetChecks: async () => ({ ok: false as const, error: 'HTTP 503' }) };
const upWith = (checks: AssetCheck[]) => ({ assetChecks: async () => ({ ok: true as const, data: checks }), allAssetChecks: async () => ({ ok: true as const, data: { 'sales/gold_orders': checks } }) });

function seedLedger(): void {
  __resetDqResults();
  recordRun({ datasetId: 'ds_1', ranAt: LEDGER_AT, badge: 'passing', healthScore: 100, results: [{ id: 'old', label: 'old probe', status: 'pass', violations: 0 }], ranBy: 'amir', domain: 'sales' });
}

test('flag ON, Dagster unreachable: the read is UNAVAILABLE with the reason — the OS ledger row is not served as the live result', async () => {
  seedLedger();
  __setDataProjectGitForTests(true);
  const r = await latestDqRun(d, { dagster: down, testedAsset: tested });
  assert.equal(r?.source, 'unavailable');
  assert.match(r!.unavailable!.reason, /HTTP 503/);
  assert.equal(r!.badge, 'unknown');
  assert.equal(r!.healthScore, null);
  assert.deepEqual(r!.results, [], 'no stale rule rows are shown as if they were current');
  // the last ledger value is only ever labelled with its own time
  assert.deepEqual(r!.unavailable!.lastKnown, { ranAt: LEDGER_AT, badge: 'passing', healthScore: 100 });
  // twin: Dagster reachable but never executed a test ⇒ the labelled OS probe, as before
  const none = await latestDqRun(d, { dagster: upWith([check({ latest: null })]), testedAsset: tested });
  assert.equal(none?.source, 'os');
  // twin: Dagster reachable with a result ⇒ the Dagster record
  const live = await latestDqRun(d, { dagster: upWith([check()]), testedAsset: tested });
  assert.equal(live?.source, 'dagster');
  assert.equal(live!.unavailable, undefined);
});

test('flag ON, Dagster unreachable: no ledger row at all is unavailable too, with no last-known value', async () => {
  __resetDqResults();
  __setDataProjectGitForTests(true);
  const r = await latestDqRun(d, { dagster: down, testedAsset: tested });
  assert.equal(r?.source, 'unavailable');
  assert.equal(r!.unavailable!.lastKnown, null);
});

test('the batch read (allAssetChecks !ok) is unavailable per dataset; a working Dagster is not', async () => {
  seedLedger();
  __setDataProjectGitForTests(true);
  const m = await readDqRuns([d], { dagster: down, testedAsset: tested });
  assert.equal(m.get('ds_1')?.source, 'unavailable');
  assert.match(m.get('ds_1')!.unavailable!.reason, /HTTP 503/);
  assert.equal(m.get('ds_1')!.unavailable!.lastKnown!.ranAt, LEDGER_AT);
  const ok = await readDqRuns([d], { dagster: upWith([check()]), testedAsset: tested });
  assert.equal(ok.get('ds_1')?.source, 'dagster');
  const viaLatest = await latestDqRuns([d], { dagster: down, testedAsset: tested });
  assert.equal(viaLatest.get('ds_1')?.source, 'unavailable');
});

test('the trend is empty while Dagster is unreachable — the ledger series is not drawn as the live trend', async () => {
  seedLedger();
  __setDataProjectGitForTests(true);
  assert.deepEqual(await dqTrend(d, { dagster: down, testedAsset: tested }), []);
  // twin: flag OFF keeps the ledger series (that IS the source then)
  __setDataProjectGitForTests(false);
  assert.equal((await dqTrend(d, { dagster: down, testedAsset: tested })).length, 1);
});

test('an unavailable record never alerts anybody', async () => {
  seedLedger();
  __resetDqAlerts();
  __setDataProjectGitForTests(true);
  const sent: string[] = [];
  const deps = { dagster: down, testedAsset: tested, ownerOf: async () => ({ owner: 'amir', name: 'x' }), alert: ((i: { datasetName: string }) => { sent.push(i.datasetName); }) as unknown as typeof deliverDqAlert };
  await latestDqRun(d, deps);
  assert.deepEqual(sent, []);
});

test('the periodic read-back that cannot reach Dagster LOGS and records its own unavailability; a good pass clears it', async (t) => {
  seedLedger();
  __resetDqAlerts();
  __setDataProjectGitForTests(true);
  const warned: string[] = [];
  t.mock.method(console, 'warn', (...a: unknown[]) => { warned.push(a.join(' ')); });
  const bad = await readbackAllDq([d], { dagster: down, testedAsset: tested });
  assert.equal(bad.unavailable, 1);
  assert.equal(bad.alerted, 0);
  assert.ok(warned.some((w) => /dq-readback/.test(w) && /HTTP 503/.test(w)), 'logged with the reason');
  assert.match(readbackWarning() ?? '', /HTTP 503/);
  // twin: the next pass reaches Dagster ⇒ the warning is cleared
  const good = await readbackAllDq([d], { dagster: upWith([check()]), testedAsset: tested });
  assert.equal(good.unavailable, 0);
  assert.equal(readbackWarning(), null);
});

/* ---------------------------------- alert dedup holds across replicas (compare-and-set claim) -- */

test('two pods reading the same failing execution send ONE alert: the shared claim is won once', async () => {
  __setDataProjectGitForTests(true);
  const claimed = new Set<string>();
  const claim = async (k: { datasetId: string; rule: string; ranAt: string }) => {
    const id = `${k.datasetId}|${k.rule}|${k.ranAt}`;
    if (claimed.has(id)) return 'lost' as const;
    claimed.add(id);
    return 'won' as const;
  };
  const sent: string[] = [];
  const mk = () => ({ claim, now: () => 'now', ownerOf: async () => ({ owner: 'amir', name: 'orders' }), alert: ((i: { failingLabels: string[] }) => { sent.push(i.failingLabels.join(',')); }) as unknown as typeof deliverDqAlert });
  const failing = checksToRecord(d, [check({ latest: { status: 'FAILED', runId: 'r9', at: '2026-11-22T06:00:00.000Z', severity: 'ERROR', description: null, metadata: { 'dagster_dbt/failed_row_count': 1 } } })])!;
  // pod A and pod B each hold their OWN (empty) in-process alert state
  __resetDqAlerts();
  assert.equal(await alertOnNewFailure(failing, mk()), 'alerted');
  __resetDqAlerts(); // pod B never saw pod A's write
  assert.equal(await alertOnNewFailure(failing, mk()), 'suppressed');
  assert.equal(sent.length, 1);
  // twin: a NEW execution (different ranAt) is a new incident and alerts again
  const next = { ...failing, ranAt: '2026-11-22T07:00:00.000Z' };
  __resetDqAlerts();
  assert.equal(await alertOnNewFailure(next, mk()), 'alerted');
  assert.equal(sent.length, 2);
});

test('the claim store unreachable: no alert is sent AND the run is not marked seen, so the next read retries', async () => {
  __setDataProjectGitForTests(true);
  __resetDqAlerts();
  let up = false;
  const claim = async () => (up ? ('won' as const) : ('unreachable' as const));
  const sent: string[] = [];
  const deps = { claim, ownerOf: async () => ({ owner: 'amir', name: 'orders' }), alert: ((i: { datasetName: string }) => { sent.push(i.datasetName); }) as unknown as typeof deliverDqAlert };
  const failing = checksToRecord(d, [check({ latest: { status: 'FAILED', runId: 'r9', at: '2026-11-22T06:00:00.000Z', severity: 'ERROR', description: null, metadata: {} } })])!;
  assert.equal(await alertOnNewFailure(failing, deps), 'skipped');
  assert.deepEqual(sent, []);
  up = true;
  assert.equal(await alertOnNewFailure(failing, deps), 'alerted');
  assert.deepEqual(sent, ['orders']);
});

/* ------------------------------------------ the WARN path on a real-shaped dagster-dbt payload -- */

test('WARN payload (dbt severity: warn through dagster-dbt 0.29.31, built from its source): a warn with 2 rows, error-free pass beside it, dataset still passing', async () => {
  const { readFileSync } = await import('node:fs');
  const payload = readFileSync(new URL('./fixtures/dagster-dq-warn-from-source.json', import.meta.url), 'utf8');
  const f = (async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const { allAssetChecks } = await import('@core/infra/dagster');
  const all = await allAssetChecks({ fetch: f, url: 'http://dagster' });
  assert.ok(all.ok);
  const checks = (all as { ok: true; data: Record<string, AssetCheck[]> }).data['sales/personal_alice/gold_shop_orders'];
  assert.equal(checks.length, 2);
  const results = checks.map(checkToResult);
  assert.deepEqual(results.find((r) => r.id === 'not_null_gold_shop_orders_customer'), {
    id: 'not_null_gold_shop_orders_customer', label: 'not_null_gold_shop_orders_customer', status: 'warn', violations: 2, severity: 'warn', at: new Date(1795339215 * 1000).toISOString(),
  });
  assert.equal(results.find((r) => r.id === 'unique_gold_shop_orders_id')!.status, 'pass');
  const rec = checksToRecord(d, checks)!;
  assert.equal(rec.badge, 'passing', 'a warn does not fail the dataset');
  assert.ok(rec.healthScore !== null && rec.healthScore < 100);
  // twin: the SAME payload with severity ERROR is a fail and the dataset is failing
  const asError = JSON.parse(payload.replace('"severity": "WARN"', '"severity": "ERROR"'));
  const e = checks.map((c) => c);
  e[1] = { ...e[1], latest: { ...e[1].latest!, severity: asError.data.assetNodes[0].assetChecksOrError.checks[1].executionForLatestMaterialization.evaluation.severity } };
  assert.equal(checksToRecord(d, e)!.badge, 'failing');
});
