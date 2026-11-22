/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Drive sync health — the bounded run history, lag, and the three owner-alert conditions.
 * USER STORY: As a drive owner I want to be told once when a sync fails, when my drive has not synced for
 *             too long, or when its connection needs reconnecting — and not again until it recovered.
 * ARCHITECTURE: pure functions (`drive-sync-health.ts`). A never-synced source has NO lag (null), never 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SYNC_RUNS, appendRun, lagMs, activeConditions, diffIncidents, lagThresholdMs, type SyncRunRecord } from '@tabs/files/lib/drive-sync-health';

const run = (at: string, ok = true, extra: Partial<SyncRunRecord> = {}): SyncRunRecord => ({ at, endedAt: at, durationMs: 5, trigger: 'schedule', ok, added: 0, changed: 0, unchanged: 0, ...(ok ? {} : { error: 'boom' }), ...extra });
const T = (m: number) => new Date(Date.UTC(2026, 10, 22, 10, m)).toISOString();
const now = Date.UTC(2026, 10, 22, 12, 0);

test('the history is bounded to the last N runs, oldest dropped', () => {
  let runs: SyncRunRecord[] | undefined;
  for (let i = 0; i < MAX_SYNC_RUNS + 5; i++) runs = appendRun(runs, run(new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
  assert.equal(runs!.length, MAX_SYNC_RUNS);
  assert.equal(runs![0].at, new Date(Date.UTC(2026, 10, 1, 0, 5)).toISOString());
});

test('lag is the time since the last SUCCESSFUL run; never synced is null, not 0 (twin)', () => {
  assert.equal(lagMs([run(T(0)), run(T(30), false)], '2026-11-01T00:00:00Z', now), now - Date.parse(T(0)));
  assert.equal(lagMs([], '2026-11-01T00:00:00Z', now), null);
  assert.equal(lagMs([run(T(30), false)], '2026-11-01T00:00:00Z', now), null);
});

test('a failed last run is a failed incident named by the start of the failing streak', () => {
  const c = activeConditions({ runs: [run(T(0)), run(T(15), false), run(T(30), false)], createdAt: T(0), paused: null }, 'healthy', now, 3600_000);
  const f = c.find((x) => x.kind === 'failed')!;
  assert.equal(f.id, `failed:${T(15)}`);
  assert.match(f.text, /boom/);
  assert.equal(activeConditions({ runs: [run(T(0), false), run(T(15))], createdAt: T(0), paused: null }, 'healthy', now, 3600_000).some((x) => x.kind === 'failed'), false, 'twin: recovered');
});

test('lag over the threshold raises; under it does not; a PAUSED source raises none (it says why itself)', () => {
  const old = { runs: [run(T(0))], createdAt: T(0), paused: null };
  assert.ok(activeConditions(old, 'healthy', now, 3600_000).some((x) => x.kind === 'lag'));
  assert.ok(!activeConditions(old, 'healthy', now, 3 * 3600_000).some((x) => x.kind === 'lag'));
  assert.ok(!activeConditions({ ...old, paused: { reason: 'owner deactivated', at: T(0) } }, 'healthy', now, 3600_000).some((x) => x.kind === 'lag'));
});

test('a source that never synced counts its age from creation (lag alert, no invented zero)', () => {
  const c = activeConditions({ runs: [], createdAt: T(0), paused: null }, 'healthy', now, 3600_000);
  assert.ok(c.some((x) => x.kind === 'lag'));
  assert.ok(!activeConditions({ runs: [], createdAt: T(100), paused: null }, 'healthy', now, 3600_000).some((x) => x.kind === 'lag'));
});

test('needs-reconnect raises; healthy and unknown do not', () => {
  const s = { runs: [run(T(100))], createdAt: T(0), paused: null };
  assert.ok(activeConditions(s, 'needs-reconnect', now, 3600_000).some((x) => x.kind === 'reconnect'));
  assert.ok(!activeConditions(s, 'healthy', now, 3600_000).some((x) => x.kind === 'reconnect'));
  assert.ok(!activeConditions(s, 'unknown', now, 3600_000).some((x) => x.kind === 'reconnect'));
});

test('each incident fires once; a cleared one may fire again later; a new failing streak fires anew', () => {
  const a = { kind: 'reconnect' as const, id: 'reconnect', text: 'x' };
  const first = diffIncidents(undefined, [a]);
  assert.equal(first.fire.length, 1);
  const again = diffIncidents(first.next, [a]);
  assert.equal(again.fire.length, 0);
  const cleared = diffIncidents(again.next, []);
  assert.deepEqual(cleared.next, {});
  assert.equal(diffIncidents(cleared.next, [a]).fire.length, 1);
  const f1 = { kind: 'failed' as const, id: 'failed:A', text: 'x' };
  const s1 = diffIncidents(undefined, [f1]).next;
  assert.equal(diffIncidents(s1, [{ ...f1, id: 'failed:B' }]).fire.length, 1);
});

test('the lag threshold is configurable and falls back on nonsense', () => {
  assert.equal(lagThresholdMs({ FILES_SYNC_LAG_ALERT_MINUTES: '30' }), 30 * 60_000);
  assert.equal(lagThresholdMs({ FILES_SYNC_LAG_ALERT_MINUTES: 'soon' }), 60 * 60_000);
  assert.equal(lagThresholdMs({}), 60 * 60_000);
});
