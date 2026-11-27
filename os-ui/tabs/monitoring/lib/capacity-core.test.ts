/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The capacity verdict's rules — thresholds, the right recommendation, honest gaps
 * USER STORY: As a platform admin I want "runs wait on an idle node" to say "raise concurrency" (the
 *             27 Nov 2026 class), "requests over the critical line" to say "next flavour / second
 *             node", and a source that did not answer to show as unavailable — never as healthy.
 * ARCHITECTURE: `assessCapacity` and the Kubernetes / run-store folds are pure; the run-queue SQL is
 *   driven through a fake `SqlClient`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCapacity,
  CAPACITY_DEFAULTS,
  foldNodeCapacity,
  foldOomKills,
  nextFlavour,
  parseQuantity,
  podRequest,
  resolveThresholds,
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
    nodes: { state: 'unavailable', reason: 'os-ui may not list pods cluster-wide' },
    usage: { state: 'unavailable', reason: 'VictoriaMetrics: unreachable' },
    oomKills: { state: 'unavailable', reason: 'os-ui may not list pods cluster-wide' },
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

test('Kubernetes quantities and the scheduler\'s effective pod request', () => {
  assert.equal(parseQuantity('7910m'), 7.91);
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity('16887Mi'), 16887 * 2 ** 20);
  assert.equal(parseQuantity('1G'), 1e9);
  assert.equal(parseQuantity('56457929034'), 56457929034);
  assert.ok(Number.isNaN(parseQuantity('lots')));
  const pod = { spec: { nodeName: 'n1', containers: [{ resources: { requests: { cpu: '100m', memory: '256Mi' } } }, { resources: { requests: { cpu: '50m' } } }], initContainers: [{ resources: { requests: { cpu: '500m', memory: '64Mi' } } }] } };
  assert.equal(podRequest(pod, 'cpu'), 0.5);
  assert.equal(podRequest(pod, 'memory'), 256 * 2 ** 20);
});

test('node capacity sums only pods that hold resources on that node', () => {
  const nodes = [{ metadata: { name: 'n1', labels: { 'node.kubernetes.io/instance-type': 'm3i.8', 'worker.gardener.cloud/pool': 'workers' } }, status: { allocatable: { cpu: '7910m', memory: '56457929034' } } }];
  const c = (cpu: string) => ({ resources: { requests: { cpu, memory: '1Gi' } } });
  const pods = [
    { spec: { nodeName: 'n1', containers: [c('1')] }, status: { phase: 'Running' } },
    { spec: { nodeName: 'n1', containers: [c('2')] }, status: { phase: 'Succeeded' } },
    { spec: { nodeName: 'n1', containers: [c('2')] }, status: { phase: 'Failed' } },
    { spec: { containers: [c('3')] }, status: { phase: 'Pending' } },
    { spec: { nodeName: 'n1', containers: [c('500m')] }, status: { phase: 'Pending' } },
  ];
  const [n] = foldNodeCapacity(nodes, pods);
  assert.deepEqual([n.flavour, n.pool, n.allocCpuCores, n.reqCpuCores, n.reqMemBytes], ['m3i.8', 'workers', 7.91, 1.5, 2 * GiB]);
});

test('OOM kills are read from lastState and state, with time and restarts', () => {
  const pods = [
    { metadata: { name: 'valkey-1', namespace: 'agentic-os', labels: { 'app.kubernetes.io/name': 'valkey' } }, status: { containerStatuses: [{ name: 'valkey', restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', finishedAt: '2026-11-27T09:56:44Z' } } }] } },
    { metadata: { name: 'job-1', namespace: 'agentic-os' }, status: { containerStatuses: [{ name: 'main', restartCount: 0, state: { terminated: { reason: 'OOMKilled', finishedAt: '2026-11-27T10:00:00Z' } } }] } },
    { metadata: { name: 'ok-1', namespace: 'agentic-os' }, status: { containerStatuses: [{ name: 'x', restartCount: 4, lastState: { terminated: { reason: 'Error', finishedAt: '2026-11-27T10:00:00Z' } } }] } },
  ];
  const k = foldOomKills(pods);
  assert.deepEqual(k.map((x) => [x.pod, x.container, x.app, x.restarts]), [['job-1', 'main', null, 0], ['valkey-1', 'valkey', 'valkey', 1]]);
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
