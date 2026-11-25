/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The alert sweep answers each caller with their own alerts
 * USER STORY: As a builder who triggers the alert sweep (or the cron that logs in to do it), I
 *             see the results of MY alerts. Every alert is still evaluated and delivered to its
 *             own owner, but another owner's metric value, read with their row security, is not
 *             shown to me. An alert whose metric or owner is gone says so.
 * ARCHITECTURE:
 *   - Drives the REAL route (`app/api/metrics/alerts/run`) over the REAL alert store; the
 *     session gate, the owner-scoped value resolution and the delivery are module mocks.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let CALLER = { id: 'amir', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' };
mock.module('@tabs/data/lib/server', { namedExports: { requirePrincipal: async () => CALLER } });

const VALUES: Record<string, { status: string; value?: number; reason?: string }> = {
  'r-amir': { status: 'ok', value: 10 },
  'r-bea': { status: 'ok', value: 999 },
  'r-gone': { status: 'orphaned', reason: 'the metric Sales.margin this alert watches was deleted or archived, or its owner can no longer see it' },
};
const evaluatedFor: string[] = [];
mock.module('@tabs/metrics/lib/build/alert-eval', {
  namedExports: {
    resolveAlertValue: async (rule: { id: string }) => {
      evaluatedFor.push(rule.id);
      return VALUES[rule.id];
    },
  },
});
const delivered: string[] = [];
mock.module('@tabs/dashboards/lib/delivery', {
  namedExports: { deliverAlert: async (_e: unknown, _m: string, to: { userId: string }) => { delivered.push(to.userId); } },
});
mock.module('@tabs/admin/lib/users', { namedExports: { getPublicUser: async () => null, authenticate: async () => null, isReserved: (id: string) => id.startsWith('__') } });

const store = await import('@tabs/metrics/lib/alert-store');
const { GET } = await import('../../../app/api/metrics/alerts/run/route.ts');

beforeEach(() => {
  store.__resetAlertStore();
  evaluatedFor.length = 0;
  delivered.length = 0;
  const base = { comparator: 'gt' as const, threshold: 5, notify: ['in_app' as const] };
  store.saveAlertRule({ id: 'r-amir', member: 'Sales.revenue', ...base }, 'amir', 'sales');
  store.saveAlertRule({ id: 'r-bea', member: 'Sales.revenue', ...base }, 'bea', 'sales');
  store.saveAlertRule({ id: 'r-gone', member: 'Sales.margin', ...base }, 'amir', 'sales');
});

async function sweep() {
  const res = await GET(new Request('http://os.local/api/metrics/alerts/run'), { params: Promise.resolve({}) } as never);
  return (await res.json()) as { evaluated: number; breached: number; results: { ruleId: string; owner: string; value: number | null; status: string; reason?: string }[] };
}

test('a builder evaluates ONLY their own alerts: another owner’s rule is neither run nor delivered', async () => {
  const body = await sweep();
  assert.deepEqual(evaluatedFor.sort(), ['r-amir', 'r-gone'], 'only the caller’s own rules run');
  assert.deepEqual(delivered, ['amir']);
  assert.deepEqual(body.results.map((r) => r.ruleId).sort(), ['r-amir', 'r-gone']);
  assert.ok(!body.results.some((r) => r.value === 999), 'another owner’s value is not in the answer');
});

test('the scheduler’s identity (OS_ALERTS_SCHEDULER_PRINCIPAL) evaluates and delivers every alert', async () => {
  process.env.OS_ALERTS_SCHEDULER_PRINCIPAL = 'svc-alerts';
  CALLER = { ...CALLER, id: 'svc-alerts', role: 'builder' };
  try {
    const body = await sweep();
    assert.deepEqual(evaluatedFor.sort(), ['r-amir', 'r-bea', 'r-gone']);
    assert.deepEqual(delivered.sort(), ['amir', 'bea']);
    assert.equal(body.results.length, 3);
  } finally {
    delete process.env.OS_ALERTS_SCHEDULER_PRINCIPAL;
    CALLER = { ...CALLER, id: 'amir', role: 'builder' };
  }
});

test('TWIN: with no scheduler configured, nobody but an admin evaluates every alert; a creator is refused', async () => {
  process.env.OS_ALERTS_SCHEDULER_PRINCIPAL = '';
  CALLER = { ...CALLER, id: 'svc-alerts', role: 'builder' };
  try {
    await sweep();
    assert.deepEqual(evaluatedFor, [], 'svc-alerts owns no rule and is not the scheduler');
    CALLER = { ...CALLER, id: 'amir', role: 'creator' };
    const res = await GET(new Request('http://os.local/api/metrics/alerts/run'), { params: Promise.resolve({}) } as never);
    assert.equal(res.status, 403);
  } finally {
    delete process.env.OS_ALERTS_SCHEDULER_PRINCIPAL;
    CALLER = { ...CALLER, id: 'amir', role: 'builder' };
  }
});

test('an admin sees every alert’s result', async () => {
  CALLER = { ...CALLER, id: 'root', role: 'admin' };
  const body = await sweep();
  assert.equal(body.results.length, 3);
  assert.deepEqual(evaluatedFor.sort(), ['r-amir', 'r-bea', 'r-gone'], 'an admin runs every rule');
  CALLER = { ...CALLER, id: 'amir', role: 'builder' };
});

test('an alert whose metric is gone is reported as orphaned with the reason', async () => {
  const body = await sweep();
  const gone = body.results.find((r) => r.ruleId === 'r-gone');
  assert.equal(gone?.status, 'orphaned');
  assert.match(gone?.reason ?? '', /was deleted or archived/);
});
