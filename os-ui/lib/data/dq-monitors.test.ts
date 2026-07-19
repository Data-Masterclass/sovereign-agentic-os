/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFreshness,
  evaluateVolume,
  evaluateSchema,
  evaluateMonitors,
  monitorEnabled,
  schemaFingerprint,
  type MonitorHistoryPoint,
} from './dq-monitors.ts';

const HOUR = 3_600_000;

/** Build an hourly-cadence history ending `hoursAgoLast` hours before `nowIso`. */
function hourly(n: number, nowMs: number, gapH = 24): MonitorHistoryPoint[] {
  const out: MonitorHistoryPoint[] = [];
  for (let i = n; i >= 1; i--) {
    out.push({ ranAt: new Date(nowMs - i * gapH * HOUR).toISOString(), rowCount: 1000, schemaFingerprint: 'a:int' });
  }
  return out;
}

test('monitorEnabled: undefined config ⇒ on (default-ON); explicit false ⇒ off', () => {
  assert.equal(monitorEnabled(undefined, 'freshness'), true);
  assert.equal(monitorEnabled({}, 'volume'), true);
  assert.equal(monitorEnabled({ schema: false }, 'schema'), false);
  assert.equal(monitorEnabled({ schema: false }, 'volume'), true);
});

test('freshness: on-cadence ⇒ pass; too-few-runs ⇒ not_run; late ⇒ fail', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  // 5 prior runs, 24h apart, last one ~24h ago (on cadence).
  const hist = hourly(5, now, 24);
  const onTime = evaluateFreshness(hist, { ranAt: new Date(now).toISOString(), rowCount: 1000, schemaFingerprint: 'a:int' });
  assert.equal(onTime.status, 'pass');

  // Too little history to learn a cadence.
  const thin = evaluateFreshness(hist.slice(0, 2), { ranAt: new Date(now).toISOString(), rowCount: 1000, schemaFingerprint: 'a:int' });
  assert.equal(thin.status, 'not_run');

  // Now is far past cadence (last run was 24h apart; observe 5 days later).
  const late = evaluateFreshness(hist, { ranAt: new Date(now + 5 * 24 * HOUR).toISOString(), rowCount: 1000, schemaFingerprint: 'a:int' });
  assert.equal(late.status, 'fail');
  assert.equal(late.violations, 1);
});

test('volume: in-band ⇒ pass; out-of-band ⇒ fail; no rowCount ⇒ not_run', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const stable: MonitorHistoryPoint[] = Array.from({ length: 6 }, (_, i) => ({
    ranAt: new Date(now - (6 - i) * 24 * HOUR).toISOString(),
    rowCount: 1000 + (i % 2), // ~constant → tiny σ
    schemaFingerprint: 'a:int',
  }));
  const inBand = evaluateVolume(stable, { ranAt: new Date(now).toISOString(), rowCount: 1001, schemaFingerprint: 'a:int' });
  assert.equal(inBand.status, 'pass');

  const spike = evaluateVolume(stable, { ranAt: new Date(now).toISOString(), rowCount: 50_000, schemaFingerprint: 'a:int' });
  assert.equal(spike.status, 'fail');
  assert.equal(spike.violations, 1);

  const noCount = evaluateVolume(stable, { ranAt: new Date(now).toISOString(), rowCount: null, schemaFingerprint: 'a:int' });
  assert.equal(noCount.status, 'not_run');

  const thin = evaluateVolume(stable.slice(0, 2), { ranAt: new Date(now).toISOString(), rowCount: 1001, schemaFingerprint: 'a:int' });
  assert.equal(thin.status, 'not_run');
});

test('schema: unchanged ⇒ pass; drift ⇒ fail naming columns; no baseline ⇒ not_run', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const base: MonitorHistoryPoint[] = [
    { ranAt: new Date(now - 2 * HOUR).toISOString(), rowCount: 10, schemaFingerprint: 'amount:double,id:int' },
  ];
  const same = evaluateSchema(base, { ranAt: new Date(now).toISOString(), rowCount: 10, schemaFingerprint: 'amount:double,id:int' });
  assert.equal(same.status, 'pass');

  const drift = evaluateSchema(base, { ranAt: new Date(now).toISOString(), rowCount: 10, schemaFingerprint: 'id:int,name:varchar' });
  assert.equal(drift.status, 'fail');
  assert.ok(/name/.test(drift.reason ?? ''), 'names the added column');
  assert.ok(/amount/.test(drift.reason ?? ''), 'names the dropped column');

  const firstRun = evaluateSchema([], { ranAt: new Date(now).toISOString(), rowCount: 10, schemaFingerprint: 'id:int' });
  assert.equal(firstRun.status, 'not_run');
});

test('schemaFingerprint is order-independent', () => {
  const a = schemaFingerprint([{ name: 'b', type: 'int' }, { name: 'a', type: 'varchar' }]);
  const b = schemaFingerprint([{ name: 'a', type: 'varchar' }, { name: 'b', type: 'int' }]);
  assert.equal(a, b);
});

test('evaluateMonitors: disabled monitor is omitted, not not_run', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const hist = hourly(5, now, 24);
  const obs = { ranAt: new Date(now).toISOString(), rowCount: 1000, schemaFingerprint: 'a:int' };
  const all = evaluateMonitors(hist, obs);
  assert.equal(all.length, 3);
  const some = evaluateMonitors(hist, obs, { volume: false });
  assert.equal(some.length, 2);
  assert.ok(!some.some((r) => r.id === 'monitor:volume'));
});
