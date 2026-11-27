/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reads the capacity signals for Monitoring → Platform → Capacity and
 *             `get_monitoring_overview` (admin), then hands them to the pure `assessCapacity`.
 * USER STORY: As a platform admin I want the capacity verdict built only from signals that really
 *             exist in this install — and every signal that did not answer named as unavailable.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY, called for admins only (the callers check the scope first).
 *   - Kubernetes API with os-ui's ServiceAccount: `GET /api/v1/nodes` (the node-list grant,
 *     charts/.../os-ui/os-ui-nodes.yaml) and `GET /api/v1/pods` cluster-wide (the capacity grant,
 *     charts/.../os-ui/os-ui-capacity.yaml: list pods, nothing else) → allocatable vs summed
 *     requests, and OOM kills from each container's `lastState.terminated.reason`.
 *     `osUI.capacityReader.enabled=false` → both are `not_measured` (off by config), no API call.
 *   - VictoriaMetrics (kubelet_stats via the Collector): node memory use now and its 1 h minimum,
 *     node CPU cores now and 1 h average — `CAPACITY_PROMQL`.
 *   - The run store (`agent_runs` database): `readRunQueue`.
 *   - Model gateway 429 / timeouts: NOT MEASURED. os-ui reads LiteLLM's spend and key APIs, but no
 *     source it reads counts rate-limited or timed-out calls per hour; the card says so.
 */
import 'server-only';
import { k8s } from '@core/infra/k8s';
import { config } from '@core/kernel/config';
import { promInstant } from '@core/adapters/victoria-metrics/query';
import { agentRunsPool, configuredAgentRunsDatabaseUrl } from '@core/adapters/postgres/pool';
import { readRunQueue } from '@tabs/monitoring/lib/adapters/run-queue';
import {
  assessCapacity,
  CAPACITY_PROMQL,
  foldNodeCapacity,
  foldNodeUsage,
  foldOomKills,
  resolveThresholds,
  type CapacityAssessment,
  type K8sNodeObj,
  type K8sPod,
  type ModelGateway,
  type NodeCapacity,
  type NodeUsage,
  type OomKill,
  type RunQueue,
  type Signal,
} from '@tabs/monitoring/lib/capacity-core';

const MODEL_GATEWAY_NOT_MEASURED =
  'os-ui has no read path that counts rate-limited (429) or timed-out model calls per hour: LiteLLM is read for spend and keys only, and its Prometheus metrics are not scraped in this install.';

function k8sFailure(path: string, status: number, grant: string): string {
  if (status === 0) return 'the Kubernetes API is not reachable from os-ui';
  if (status === 401) return 'the Kubernetes API rejected os-ui\'s ServiceAccount token';
  if (status === 403) return `os-ui may not ${grant}: the ClusterRole is missing (${path})`;
  return `GET ${path} answered ${status}`;
}

async function readCluster(): Promise<{ nodes: Signal<NodeCapacity[]>; oomKills: Signal<OomKill[]> }> {
  if (!config.capacityReaderEnabled) {
    const off = { state: 'not_measured' as const, reason: 'the capacity reader is off on this install (osUI.capacityReader.enabled=false)' };
    return { nodes: off, oomKills: off };
  }
  const [n, p] = await Promise.all([k8s('GET', '/api/v1/nodes'), k8s('GET', '/api/v1/pods?limit=2000')]);
  if (p.status !== 200) {
    const reason = k8sFailure('/api/v1/pods', p.status, 'list pods cluster-wide');
    const nodes: Signal<NodeCapacity[]> = n.status !== 200 ? { state: 'unavailable', reason: k8sFailure('/api/v1/nodes', n.status, 'list nodes') } : { state: 'unavailable', reason: `pod requests unknown — ${reason}` };
    return { nodes, oomKills: { state: 'unavailable', reason } };
  }
  const pods = (p.body.items as K8sPod[] | undefined) ?? [];
  // A cluster with more pods than one page holds would be summed short: say so rather than undercount.
  const more = Boolean((p.body.metadata as { continue?: string } | undefined)?.continue);
  const oomKills: Signal<OomKill[]> = { state: 'live', value: foldOomKills(pods) };
  if (n.status !== 200) return { nodes: { state: 'unavailable', reason: k8sFailure('/api/v1/nodes', n.status, 'list nodes') }, oomKills };
  if (more) return { nodes: { state: 'unavailable', reason: 'more than 2000 pods: the requests cannot be summed from one page' }, oomKills };
  return { nodes: { state: 'live', value: foldNodeCapacity((n.body.items as K8sNodeObj[] | undefined) ?? [], pods) }, oomKills };
}

async function readUsage(): Promise<Signal<NodeUsage[]>> {
  const [memNow, memMin1h, cpuNow, cpuAvg1h] = await Promise.all([
    promInstant(CAPACITY_PROMQL.memNow),
    promInstant(CAPACITY_PROMQL.memMin1h),
    promInstant(CAPACITY_PROMQL.cpuNow),
    promInstant(CAPACITY_PROMQL.cpuAvg1h),
  ]);
  const bad = [memNow, memMin1h, cpuNow, cpuAvg1h].find((r) => !r.ok);
  if (bad && !bad.ok) return { state: 'unavailable', reason: `VictoriaMetrics: ${bad.detail}` };
  if (!memNow.ok || !memMin1h.ok || !cpuNow.ok || !cpuAvg1h.ok) return { state: 'unavailable', reason: 'VictoriaMetrics: no answer' };
  if (memNow.value.length === 0 && cpuNow.value.length === 0) return { state: 'unavailable', reason: 'VictoriaMetrics holds no kubelet_stats node series (observability.collector.kubeletStats)' };
  return { state: 'live', value: foldNodeUsage({ memNow: memNow.value, memMin1h: memMin1h.value, cpuNow: cpuNow.value, cpuAvg1h: cpuAvg1h.value }) };
}

async function readQueue(nowMs: number): Promise<Signal<RunQueue>> {
  const url = configuredAgentRunsDatabaseUrl();
  if (!url) return { state: 'unavailable', reason: 'no durable run store is configured (AGENT_RUNS_DATABASE_URL)' };
  try {
    return { state: 'live', value: await readRunQueue(await agentRunsPool(url), nowMs) };
  } catch (e) {
    return { state: 'unavailable', reason: `run store: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function collectCapacity(nowMs = Date.now()): Promise<CapacityAssessment> {
  const { thresholds, configErrors } = resolveThresholds(config.capacityThresholdOverrides);
  const [cluster, usage, runQueue] = await Promise.all([readCluster(), readUsage(), readQueue(nowMs)]);
  const modelGateway: Signal<ModelGateway> = { state: 'not_measured', reason: MODEL_GATEWAY_NOT_MEASURED };
  return assessCapacity({
    nowMs,
    thresholds,
    configErrors,
    nodes: cluster.nodes,
    usage,
    oomKills: cluster.oomKills,
    runQueue,
    modelGateway,
    executor: { mode: config.agentsWorker === 'worker' ? 'worker' : 'inline' },
    platformNamespace: config.platformNamespace,
  });
}
