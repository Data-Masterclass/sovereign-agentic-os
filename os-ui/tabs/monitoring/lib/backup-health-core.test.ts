/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-56 backup/drill assessment — evidence rules
 * USER STORY: As a platform admin I want no green light without evidence, and an alert for every
 *             failed bundle or drill.
 * ARCHITECTURE:
 *   - Pure function over the shapes the real jobs write (git-bundler.sh status, drill-report.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessBackups, backupAlerts, type BackupInputs } from '@tabs/monitoring/lib/backup-health-core';

const now = new Date('2026-11-20T12:00:00Z');
const base = (over: Partial<BackupInputs> = {}): BackupInputs => ({
  bundlesEnabled: true,
  bundler: { lastRescanAt: '2026-11-20T11:55:00Z', lastRefsRecordAt: '2026-11-20T11:30:00Z', repos: { sales: { status: 'ok', at: '2026-11-20T11:55:00Z' } } },
  rescanSeconds: 600,
  refsRecordSeconds: 3600,
  drills: [
    { kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2026-11-18T04:00:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }] } },
    { kind: 'velero', enabled: false, maxAgeDays: 32, report: null },
  ],
  now,
  ...over,
});
const byId = (items: ReturnType<typeof assessBackups>) => Object.fromEntries(items.map((i) => [i.id, i]));

test('all evidence present and fresh ⇒ green bundles and green drill; an off drill says off', () => {
  const m = byId(assessBackups(base()));
  assert.equal(m['bk-bundles'].health, 'green');
  assert.equal(m['bk-drill-weekly'].health, 'green');
  assert.equal(m['bk-drill-velero'].health, 'unknown');
  assert.ok(Object.values(m).every((i) => i.cluster === true));
  assert.deepEqual(backupAlerts(Object.values(m)), []);
});

test('NEGATIVE: a failed drill check is red and raises a critical alert, even if the report claims pass', () => {
  const items = assessBackups(base({
    drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2026-11-19T04:00:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }, { check: 'postgres', status: 'fail', reason: 'pg_restore: boom' }] } }],
  }));
  const d = byId(items)['bk-drill-weekly'];
  assert.equal(d.health, 'red');
  assert.match(d.detail, /postgres: pg_restore: boom/);
  const alerts = backupAlerts(items);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
});

test('NEGATIVE: no status, no report, a stale report or a failing repo is never green', () => {
  assert.equal(byId(assessBackups(base({ bundler: null })))['bk-bundles'].health, 'red');
  assert.equal(byId(assessBackups(base({ bundlesEnabled: false })))['bk-bundles'].health, 'amber');
  const noReport = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: null }] })));
  assert.equal(noReport['bk-drill-weekly'].health, 'red', 'an enabled drill that never reported is red');
  const stale = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2026-11-01T04:00:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }] } }] })));
  assert.equal(stale['bk-drill-weekly'].health, 'red', 'an overdue drill is red');
  const future = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2027-11-20T04:00:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }] } }] })));
  assert.equal(future['bk-drill-weekly'].health, 'red', 'a pass dated in the future is not green');
  const skew = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2026-11-20T12:10:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }] } }] })));
  assert.equal(skew['bk-drill-weekly'].health, 'green', 'a few minutes of clock skew is allowed');
  const missingStaleFuture = assessBackups(base({ drills: [
    { kind: 'weekly', enabled: true, maxAgeDays: 8, report: null },
    { kind: 'velero', enabled: true, maxAgeDays: 32, report: { kind: 'velero', at: '2026-09-01T05:00:00Z', status: 'pass', checks: [{ check: 'velero', status: 'pass' }] } },
  ] }));
  assert.equal(backupAlerts(missingStaleFuture).length, 2, 'a missing and an overdue report each raise a critical alert');
  const unreadable = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: null, readError: 'HTTP 403' }] })));
  assert.equal(unreadable['bk-drill-weekly'].health, 'red');
  const failing = assessBackups(base({ bundler: { lastRescanAt: '2026-11-20T11:55:00Z', lastRefsRecordAt: '2026-11-20T11:30:00Z', repos: { sales: { status: 'error', at: '2026-11-20T11:55:00Z', last: { reason: 'bundle verify failed' } } } } }));
  assert.equal(byId(failing)['bk-bundle-sales'].health, 'red');
  assert.equal(byId(failing)['bk-bundles'], undefined, 'no green roll-up while a repo fails');
  const stalledItems = assessBackups(base({ bundler: { lastRescanAt: '2026-11-20T09:00:00Z', lastRefsRecordAt: 'garbage', repos: {} } }));
  const stalled = byId(stalledItems);
  assert.equal(stalled['bk-bundles-stale'].health, 'red', 'a stalled sidecar is red');
  assert.equal(stalled['bk-refs-record'].health, 'red', 'an unreadable record time is never fresh');
  assert.equal(backupAlerts(stalledItems).length, 2, 'and both raise an alert');
  const empty = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: '2026-11-19T04:00:00Z', status: 'pass', checks: [] } }] })));
  assert.equal(empty['bk-drill-weekly'].health, 'red', 'a pass with no check proves nothing');
  const nan = byId(assessBackups(base({ drills: [{ kind: 'weekly', enabled: true, maxAgeDays: 8, report: { kind: 'weekly', at: 'not-a-date', status: 'pass', checks: [{ check: 'git', status: 'pass' }] } }] })));
  assert.equal(nan['bk-drill-weekly'].health, 'red', 'an unreadable report time is not green');
});
