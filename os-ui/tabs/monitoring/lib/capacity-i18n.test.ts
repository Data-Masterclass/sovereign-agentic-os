/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The capacity card speaks all seven languages, and its English is the server's English
 * USER STORY: As a German admin I read the capacity findings and recommendations in German; an MCP client
 *             reads the same words in English — and the two never drift apart.
 * ARCHITECTURE: Builds assessments that raise every finding code and every action code, then renders
 *   `monitoring.panels.platform.capacity.finding.<code>` / `.action.<action>` with the finding's params
 *   through the on-disk catalogs (the ICU engine next-intl uses): English must equal `title` /
 *   `recommendation` byte for byte; every other locale must render non-empty with no placeholder left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LOCALES, catalogText } from '@core/testing/catalog-text';
import { ACTION_CODES, assessCapacity, CAPACITY_DEFAULTS, FINDING_CODES, HEADLINES, type CapacityFinding, type CapacityInput } from '@tabs/monitoring/lib/capacity-core';

const NOW = Date.parse('2026-11-27T14:00:00Z');
const GiB = 2 ** 30;
const base = (over: Partial<CapacityInput>): CapacityInput => ({
  nowMs: NOW,
  thresholds: CAPACITY_DEFAULTS,
  nodes: { state: 'live', value: [{ name: 'n1', flavour: 'm3i.8', pool: 'workers', allocCpuCores: 8, allocMemBytes: 64 * GiB, reqCpuCores: 1, reqMemBytes: 8 * GiB }] },
  usage: { state: 'live', value: [{ name: 'n1', memNow: 0.3, memMin1h: 0.3, cpuCoresNow: 1, cpuCoresAvg1h: 1 }] },
  oomKills: { state: 'live', value: [] },
  runQueue: { state: 'live', value: { queued: 0, running: 0, oldestQueuedWaitSec: null, startedLastHour: 0, p95StartWaitSec: null, finishedLastHour: 0, p95RunSec: null } },
  modelGateway: { state: 'not_measured', reason: 'x' },
  executor: { mode: 'worker' },
  platformNamespace: 'agentic-os',
  ...over,
});

function everyFinding(): CapacityFinding[] {
  const q = { queued: 1203, running: 1, oldestQueuedWaitSec: 2095, startedLastHour: 14, p95StartWaitSec: 1900, finishedLastHour: 12, p95RunSec: 750 };
  const kill = { namespace: 'agentic-os', pod: 'valkey-1', container: 'valkey', app: 'valkey', at: NOW - 60_000, restarts: 1 };
  const runs = [
    // requests warn (plan) on a two-node pool; memory peak (watch); one OOM with a values key; queue on an idle node; long runs; model errors
    base({
      nodes: { state: 'live', value: [{ name: 'n1', flavour: 'm3i.8', pool: 'w', allocCpuCores: 8, allocMemBytes: 64 * GiB, reqCpuCores: 6.5, reqMemBytes: 50 * GiB }, { name: 'n2', flavour: null, pool: 'w', allocCpuCores: 8, allocMemBytes: 64 * GiB, reqCpuCores: 1, reqMemBytes: 1 * GiB }] },
      usage: { state: 'live', value: [{ name: 'n1', memNow: 0.85, memMin1h: 0.4, cpuCoresNow: 1, cpuCoresAvg1h: 1 }] },
      oomKills: { state: 'live', value: [kill, { ...kill, namespace: 'ingress-nginx', app: 'ingress-nginx', pod: 'ctrl-1', container: 'controller', restarts: 2 }] },
      runQueue: { state: 'live', value: q },
      modelGateway: { state: 'live', value: { calls: 1500, rateLimitedOrTimedOut: 120 } },
    }),
    // requests critical on a single-node pool + sustained memory; the queue then says capacity first
    base({
      nodes: { state: 'live', value: [{ name: 'n1', flavour: 'm3i.8', pool: 'w', allocCpuCores: 8, allocMemBytes: 64 * GiB, reqCpuCores: 7.5, reqMemBytes: 60 * GiB }] },
      usage: { state: 'live', value: [{ name: 'n1', memNow: 0.9, memMin1h: 0.82, cpuCoresNow: 1, cpuCoresAvg1h: 1 }] },
      runQueue: { state: 'live', value: q },
    }),
    // a drained queue (recent wait), inline executor
    base({ executor: { mode: 'inline' }, runQueue: { state: 'live', value: { ...q, queued: 0, oldestQueuedWaitSec: null } } }),
  ];
  return runs.flatMap((r) => assessCapacity(r).findings);
}

const K = 'panels.platform.capacity';

test('every finding and action code is raised by the fixtures (so the next test covers them all)', () => {
  const f = everyFinding();
  assert.deepEqual([...new Set(f.map((x) => x.code))].sort(), [...FINDING_CODES].sort());
  assert.deepEqual([...new Set(f.map((x) => x.action))].sort(), [...ACTION_CODES].sort());
});

test('the English catalog renders exactly the server\'s title and recommendation; every locale renders', () => {
  for (const f of everyFinding()) {
    assert.equal(catalogText('monitoring', { key: `${K}.finding.${f.code}`, args: f.params }), f.title, `${f.id}: finding.${f.code}`);
    assert.equal(catalogText('monitoring', { key: `${K}.action.${f.action}`, args: f.actionParams }), f.recommendation, `${f.id}: action.${f.action}`);
    for (const l of CATALOG_LOCALES) {
      for (const [key, args] of [[`${K}.finding.${f.code}`, f.params], [`${K}.action.${f.action}`, f.actionParams]] as const) {
        const text = catalogText('monitoring', { key, args }, l);
        assert.ok(text.trim().length > 0 && !/\{[a-zA-Z]+\}/.test(text), `${l} ${key} renders: ${text}`);
      }
    }
  }
});

test('every headline has a catalog line in every locale', () => {
  for (const h of HEADLINES) for (const l of CATALOG_LOCALES) assert.ok(catalogText('monitoring', { key: `${K}.headline.${h}` }, l).length > 0, `${l} headline.${h}`);
});
