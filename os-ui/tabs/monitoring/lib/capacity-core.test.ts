/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The capacity verdict's rules — thresholds, the right recommendation, honest gaps
 * USER STORY: As a platform admin I want "runs wait on an idle node" to say "raise concurrency" (the
 *             27 Nov 2026 class), "requests over the critical line" to say "next flavour / second
 *             node", and a source that did not answer to show as unavailable — never as healthy.
 * ARCHITECTURE: `assessCapacity` and the kube-state-metrics folds are pure (samples shaped like
 *   VictoriaMetrics' answer); the run-queue SQL is driven through a fake `SqlClient`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCapacity,
  CAPACITY_DEFAULTS,
  foldKsmCapacity,
  foldKsmOomKills,
  nextFlavour,
  resolveThresholds,
  ttlMemo,
  valuesKeyFor,
  type CapacityInput,
  type NodeCapacity,
  type RunQueue,
} from '@tabs/monitoring/lib/capacity-core';
import { readRunQueue, QUEUE_HOUR_SQL, QUEUE_NOW_SQL } from '@tabs/monitoring/lib/adapters/run-queue';

const NOW = Date.parse('2026-11-27T14:00:00Z');
const GiB = 2 ** 30;

/** The production node on 27 Nov 2026: m3i.8, 7.91 cores / 52.6 GiB allocatable, 76 % CPU / 31 % memory requested. */
const node = (over: Partial<NodeCapacity> = {}): NodeCapacity => ({
  name: 'n1',
  flavour: 'm3i.8',
  pool: 'workers',
  allocCpuCores: 7.91,
  allocMemBytes: 52.58 * GiB,
  reqCpuCores: 6.012,
  reqMemBytes: 16.49 * GiB,
  ...over,
});
const idleQueue: RunQueue = { queued: 0, running: 1, oldestQueuedWaitSec: null, startedLastHour: 10, p95StartWaitSec: 4, finishedLastHour: 9, p95RunSec: 120 };

function input(over: Partial<CapacityInput> = {}): CapacityInput {
  return {
    nowMs: NOW,
    thresholds: CAPACITY_DEFAULTS,
    nodes: { state: 'live', value: [node()] },
    usage: { state: 'live', value: [{ name: 'n1', memNow: 0.43, memMin1h: 0.4, cpuCoresNow: 0.5, cpuCoresAvg1h: 0.6 }] },
    oomKills: { state: 'live', value: [] },
    runQueue: { state: 'live', value: idleQueue },
    modelGateway: { state: 'not_measured', reason: 'no read path' },
    executor: { mode: 'worker' },
    platformNamespace: 'agentic-os',
    ...over,
  };
}

test('the documented defaults', () => {
  assert.deepEqual(CAPACITY_DEFAULTS, {
    memRequestsWarn: 0.75, memRequestsCrit: 0.85, cpuRequestsWarn: 0.8, cpuRequestsCrit: 0.9, memUsageWarn: 0.8,
    queueWaitWarnSec: 60, queueWaitCritSec: 300, runP95WarnSec: 600, modelErrorRateWarn: 0.02,
  });
});

test('a healthy node and an empty queue: ok, no findings, the model gateway stays "not measured"', () => {
  const a = assessCapacity(input());
  assert.equal(a.verdict, 'ok');
  assert.equal(a.headline, 'healthy');
  assert.deepEqual(a.findings, []);
  assert.equal(a.sources.modelGateway.state, 'not_measured');
  assert.equal(Math.round(a.nodes[0].cpuRequests * 100), 76);
  assert.equal(Math.round(a.nodes[0].memRequests * 100), 31);
});

test('27 Nov 2026: runs wait up to 35 min on an idle node → raise concurrency, NOT a bigger server', () => {
  const a = assessCapacity(input({ runQueue: { state: 'live', value: { ...idleQueue, queued: 11, running: 1, oldestQueuedWaitSec: 2095 } } }));
  assert.equal(a.verdict, 'critical');
  assert.equal(a.headline, 'raiseConcurrency');
  const f = a.findings.find((x) => x.code === 'queueWait')!;
  assert.equal(f.severity, 'critical');
  assert.equal(f.action, 'raiseConcurrency');
  assert.match(f.recommendation, /osUI\.worker\.concurrency or osUI\.worker\.replicas/);
  assert.match(f.recommendation, /not a reason to buy a bigger server/);
  assert.ok(!a.findings.some((x) => x.action === 'upgradeNode'), 'no upgrade advice while requests are below critical');
});

test('queue wait thresholds: 59 s nothing, 60 s warning, 300 s critical', () => {
  const at = (sec: number) => assessCapacity(input({ runQueue: { state: 'live', value: { ...idleQueue, queued: 1, oldestQueuedWaitSec: sec } } })).findings.find((f) => f.code === 'queueWait');
  assert.equal(at(59), undefined);
  assert.equal(at(60)?.severity, 'warning');
  assert.equal(at(299)?.severity, 'warning');
  assert.equal(at(300)?.severity, 'critical');
});

test('a queue that has drained still shows the last hour\'s p95 wait-to-start', () => {
  const f = assessCapacity(input({ runQueue: { state: 'live', value: { ...idleQueue, p95StartWaitSec: 1200 } } })).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'queueWaitRecent');
  assert.equal(f[0].severity, 'critical');
});

test('runs inline in os-ui → turn the worker on', () => {
  const f = assessCapacity(input({ executor: { mode: 'inline' }, runQueue: { state: 'live', value: { ...idleQueue, queued: 3, oldestQueuedWaitSec: 90 } } })).findings[0];
  assert.equal(f.action, 'enableWorker');
  assert.match(f.recommendation, /osUI\.worker\.enabled=true/);
});

test('queue wait on a FULL node → capacity first, then concurrency', () => {
  const a = assessCapacity(input({
    nodes: { state: 'live', value: [node({ reqCpuCores: 7.3 })] },
    runQueue: { state: 'live', value: { ...idleQueue, queued: 3, oldestQueuedWaitSec: 400 } },
  }));
  assert.equal(a.headline, 'upgradeNode');
  assert.equal(a.findings.find((f) => f.code === 'queueWait')!.action, 'capacityFirst');
});

test('CPU requests: 79 % nothing, 80 % warning (plan, no purchase), 90 % critical (next flavour + autoscaler)', () => {
  const at = (req: number) => assessCapacity(input({ nodes: { state: 'live', value: [node({ reqCpuCores: req * 7.91 })] } })).findings.find((f) => f.code === 'cpuRequests');
  assert.equal(at(0.79), undefined);
  const warn = at(0.8)!;
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.action, 'planCapacity');
  assert.match(warn.recommendation, /no purchase is needed today/);
  const crit = at(0.9)!;
  assert.equal(crit.severity, 'critical');
  assert.equal(crit.action, 'upgradeNode');
  assert.match(crit.recommendation, /m3i\.8 → m3i\.16/);
  assert.match(crit.recommendation, /cluster autoscaler \(node pool maximum > 1\)/, 'a single-node pool also gets the autoscaler advice');
});

test('memory requests: 75 % warning, 85 % critical; a pool with two nodes gets no autoscaler line', () => {
  const two = (req: number) => assessCapacity(input({ nodes: { state: 'live', value: [node({ reqMemBytes: req * 52.58 * GiB }), node({ name: 'n2' })] } })).findings.filter((f) => f.code === 'memRequests');
  assert.equal(two(0.74).length, 0);
  assert.equal(two(0.75)[0].severity, 'warning');
  const crit = two(0.85)[0];
  assert.equal(crit.severity, 'critical');
  assert.doesNotMatch(crit.recommendation, /autoscaler/);
});

test('memory USE: a peak warns (watch), only a sustained hour above 80 % recommends an upgrade', () => {
  const peak = assessCapacity(input({ usage: { state: 'live', value: [{ name: 'n1', memNow: 0.83, memMin1h: 0.5, cpuCoresNow: 1, cpuCoresAvg1h: 1 }] } }));
  assert.deepEqual(peak.findings.map((f) => [f.code, f.severity, f.action]), [['memUsage', 'warning', 'watchMemory']]);
  const stays = assessCapacity(input({ usage: { state: 'live', value: [{ name: 'n1', memNow: 0.86, memMin1h: 0.81, cpuCoresNow: 1, cpuCoresAvg1h: 1 }] } }));
  assert.deepEqual(stays.findings.map((f) => [f.code, f.severity, f.action]), [['memUsageSustained', 'critical', 'upgradeNode']]);
  assert.equal(stays.headline, 'upgradeNode');
});

test('OOM kills in 24 h: warning with the chart values key; repeated → critical; older than 24 h → nothing', () => {
  const kill = { namespace: 'agentic-os', pod: 'valkey-6fcf', container: 'valkey', app: 'valkey', at: NOW - 3_600_000, restarts: 1 };
  const one = assessCapacity(input({ oomKills: { state: 'live', value: [kill] } }));
  assert.equal(one.headline, 'fixMemoryLimits');
  assert.equal(one.findings[0].code, 'oomKill');
  assert.equal(one.findings[0].severity, 'warning');
  assert.equal(one.findings[0].action, 'raiseMemoryLimitKey');
  assert.match(one.findings[0].recommendation, /values key valkey\.resources\.limits\.memory/);
  const again = assessCapacity(input({ oomKills: { state: 'live', value: [{ ...kill, restarts: 3 }] } }));
  assert.equal(again.findings[0].code, 'oomKillRepeated');
  assert.equal(again.findings[0].severity, 'critical');
  assert.ok(!again.findings.some((f) => f.action === 'upgradeNode'), 'an OOM kill is a limit problem, not a node problem');
  assert.deepEqual(assessCapacity(input({ oomKills: { state: 'live', value: [{ ...kill, at: NOW - 2 * 86_400_000 }] } })).findings, []);
  const foreign = assessCapacity(input({ oomKills: { state: 'live', value: [{ ...kill, namespace: 'ingress-nginx', app: 'ingress-nginx', container: 'controller' }] } }));
  assert.equal(foreign.findings[0].action, 'raiseMemoryLimit');
});

test('p95 run duration ≥ 10 min warns and points at the runs, not the queue', () => {
  const f = assessCapacity(input({ runQueue: { state: 'live', value: { ...idleQueue, p95RunSec: 600 } } })).findings;
  assert.deepEqual(f.map((x) => [x.code, x.severity, x.action]), [['runDuration', 'warning', 'investigateRunDuration']]);
  assert.equal(assessCapacity(input({ runQueue: { state: 'live', value: { ...idleQueue, p95RunSec: 599 } } })).findings.length, 0);
});

test('model gateway: only a real count can warn (> 2 %)', () => {
  const at = (bad: number) => assessCapacity(input({ modelGateway: { state: 'live', value: { calls: 1000, rateLimitedOrTimedOut: bad } } })).findings;
  assert.equal(at(20).length, 0);
  assert.equal(at(21)[0].code, 'modelErrors');
});

test('unavailable sources are shown as unavailable, never as healthy', () => {
  const down = assessCapacity(input({
    nodes: { state: 'unavailable', reason: 'VictoriaMetrics: unreachable' },
    usage: { state: 'unavailable', reason: 'VictoriaMetrics: unreachable' },
    oomKills: { state: 'unavailable', reason: 'VictoriaMetrics: unreachable' },
    runQueue: { state: 'unavailable', reason: 'no durable run store' },
  }));
  assert.equal(down.verdict, 'unknown');
  assert.equal(down.headline, 'unknown');
  assert.deepEqual(down.nodes, []);
  assert.equal(down.queue, null);
  assert.equal(down.sources.nodes.state, 'unavailable');

  const some = assessCapacity(input({ runQueue: { state: 'unavailable', reason: 'run store: timeout' } }));
  assert.equal(some.verdict, 'ok');
  assert.equal(some.headline, 'partial', 'no finding in what answered, but not "healthy" while a source is missing');

  const noUsage = assessCapacity(input({ usage: { state: 'unavailable', reason: 'VictoriaMetrics: unreachable' } }));
  assert.equal(noUsage.nodes[0].memUsage, null, 'usage is null, never 0');
  assert.equal(noUsage.headline, 'partial');
});

test('thresholds come from config; invalid overrides keep the default and are reported', () => {
  const ok = resolveThresholds({ cpuRequestsWarn: '0.7', queueWaitWarnSec: '30' });
  assert.equal(ok.thresholds.cpuRequestsWarn, 0.7);
  assert.equal(ok.thresholds.queueWaitWarnSec, 30);
  assert.deepEqual(ok.configErrors, []);
  const bad = resolveThresholds({ memRequestsWarn: '75', queueWaitCritSec: 'soon', memUsageWarn: '' });
  assert.equal(bad.thresholds.memRequestsWarn, 0.75);
  assert.equal(bad.thresholds.queueWaitCritSec, 300);
  assert.equal(bad.configErrors.length, 2);
  const inverted = resolveThresholds({ cpuRequestsWarn: '0.95' });
  assert.equal(inverted.thresholds.cpuRequestsWarn, 0.8);
  assert.match(inverted.configErrors[0], /OS_CAPACITY_CPU_REQUESTS_WARN/);
  const a = assessCapacity({ ...input(), configErrors: bad.configErrors });
  assert.equal(a.configErrors.length, 2);
});

const m = (metric: Record<string, string>, value: number) => ({ metric, value });
const req = (pod: string, container: string, resource: 'cpu' | 'memory', value: number, node = 'n1', namespace = 'agentic-os') => m({ namespace, pod, container, node, resource }, value);

test('kube-state-metrics: allocatable, flavour/pool labels and summed requests per node; finished pods hold nothing', () => {
  const [n] = foldKsmCapacity({
    allocatable: [m({ node: 'n1', resource: 'cpu', unit: 'core' }, 7.91), m({ node: 'n1', resource: 'memory', unit: 'byte' }, 56457929034)],
    nodeLabels: [m({ node: 'n1', label_node_kubernetes_io_instance_type: 'm3i.8', label_worker_gardener_cloud_pool: 'workers' }, 1)],
    requests: [req('a', 'main', 'cpu', 1), req('a', 'main', 'memory', GiB), req('done', 'main', 'cpu', 2), req('b', 'main', 'cpu', 0.5), req('other', 'x', 'cpu', 3, 'n2')],
    initRequests: [],
    sidecars: [],
    terminal: [m({ namespace: 'agentic-os', pod: 'done', phase: 'Succeeded' }, 1)],
  });
  assert.deepEqual([n.name, n.flavour, n.pool, n.allocCpuCores, n.reqCpuCores, n.reqMemBytes], ['n1', 'm3i.8', 'workers', 7.91, 1.5, GiB]);
});

test('native sidecars (init, restartPolicy Always) are SUMMED with the app; regular init containers are maxed', () => {
  const [n] = foldKsmCapacity({
    allocatable: [m({ node: 'n1', resource: 'cpu' }, 8), m({ node: 'n1', resource: 'memory' }, 64 * GiB)],
    nodeLabels: [],
    requests: [req('p', 'app', 'cpu', 1), req('q', 'app', 'cpu', 0.1)],
    initRequests: [req('p', 'proxy', 'cpu', 0.25), req('p', 'migrate', 'cpu', 0.5), req('p', 'seed', 'cpu', 0.4), req('q', 'big-init', 'cpu', 2)],
    sidecars: [m({ namespace: 'agentic-os', pod: 'p', container: 'proxy', restart_policy: 'Always' }, 1)],
    terminal: [],
  });
  // p: max(app 1 + sidecar 0.25, regular init 0.5 + sidecar 0.25) = 1.25 ; q: max(0.1, 2) = 2
  assert.equal(n.reqCpuCores, 3.25);
});

test('kube-state-metrics: OOM kills with time, restarts and the app label', () => {
  const ctr = { namespace: 'agentic-os', pod: 'valkey-1', container: 'valkey' };
  const k = foldKsmOomKills({
    oomKilled: [m({ ...ctr, reason: 'OOMKilled' }, 1), m({ namespace: 'x', pod: 'nots', container: 'c', reason: 'OOMKilled' }, 1)],
    terminatedAt: [m(ctr, Date.parse('2026-11-27T09:56:44Z') / 1000)],
    restarts: [m(ctr, 1)],
    podLabels: [m({ namespace: 'agentic-os', pod: 'valkey-1', label_app_kubernetes_io_name: 'valkey' }, 1)],
  });
  assert.deepEqual(k, [{ namespace: 'agentic-os', pod: 'valkey-1', container: 'valkey', app: 'valkey', at: Date.parse('2026-11-27T09:56:44Z'), restarts: 1 }], 'a kill without a termination time cannot be placed in 24 h and is left out');
});

test('the 30 s cache shares one read, and does not keep a failure', async () => {
  let calls = 0;
  let t = 0;
  let fail = false;
  const get = ttlMemo(async () => { calls++; if (fail) throw new Error('down'); return calls; }, 30_000, () => t);
  assert.equal(await get(), 1);
  t = 29_999;
  assert.equal(await get(), 1);
  t = 30_000;
  assert.equal(await get(), 2);
  fail = true;
  t = 70_000;
  await assert.rejects(get());
  fail = false;
  assert.equal(await get(), 4, 'a failed read is retried on the next call');
});

test('next flavour and values keys', () => {
  assert.equal(nextFlavour('m3i.8'), 'm3i.16');
  assert.equal(nextFlavour('g1.4'), 'g1.8');
  assert.equal(nextFlavour(null), null);
  assert.equal(nextFlavour('Standard_D8s_v5'), null);
  assert.equal(valuesKeyFor({ namespace: 'agentic-os', app: 'os-ui-worker', container: 'worker' }, 'agentic-os'), 'osUI.worker.resources.limits.memory');
  assert.equal(valuesKeyFor({ namespace: 'agentic-os', app: 'langfuse', container: 'web' }, 'agentic-os'), 'langfuse.langfuse.web.resources.limits.memory');
  assert.equal(valuesKeyFor({ namespace: 'kube-system', app: 'os-ui', container: 'os-ui' }, 'agentic-os'), null);
});

test('the run queue is read from the run store: oldest wait, p95 wait-to-start, p95 duration', async () => {
  const seen: { text: string; values?: unknown[] }[] = [];
  const sql = {
    async query(text: string, values?: unknown[]) {
      seen.push({ text, values });
      if (text === QUEUE_NOW_SQL) return { rows: [{ queued: 11, running: 1, oldest_wait: 2095.4 }] };
      if (text === QUEUE_HOUR_SQL) return { rows: [{ started: 14, p95_wait: '1900.2', finished: 12, p95_run: null }] };
      throw new Error('unexpected query');
    },
  };
  const q = await readRunQueue(sql, NOW);
  assert.deepEqual(q, { queued: 11, running: 1, oldestQueuedWaitSec: 2095.4, startedLastHour: 14, p95StartWaitSec: 1900.2, finishedLastHour: 12, p95RunSec: null });
  assert.equal((seen.find((s) => s.text === QUEUE_HOUR_SQL)!.values![0] as Date).toISOString(), '2026-11-27T13:00:00.000Z');
  // An empty queue: no wait, never 0 s.
  const empty = await readRunQueue({ query: async (text: string) => ({ rows: [text === QUEUE_NOW_SQL ? { queued: 0, running: 0, oldest_wait: null } : { started: 0, p95_wait: null, finished: 0, p95_run: null }] }) }, NOW);
  assert.equal(empty.oldestQueuedWaitSec, null);
});

test('kube-state-metrics off or not scraped: node requests and OOM kills read "not measured", the headline is never healthy', () => {
  const off = { state: 'not_measured' as const, reason: 'kube-state-metrics is off on this install' };
  const a = assessCapacity(input({ nodes: off, oomKills: off }));
  assert.equal(a.sources.nodes.state, 'not_measured');
  assert.equal(a.sources.oomKills.state, 'not_measured');
  assert.deepEqual(a.nodes, []);
  assert.equal(a.headline, 'partial');
});
