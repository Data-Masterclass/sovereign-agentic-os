/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reads the capacity signals for Monitoring → Platform → Capacity and
 *             `get_monitoring_overview` (admin), then hands them to the pure `assessCapacity`.
 * USER STORY: As a platform admin I want the capacity verdict built only from signals that really
 *             exist in this install — and every signal that did not answer named as unavailable.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY, called for admins only (the callers check the scope first). No
 *     Kubernetes API call: os-ui holds no cluster-wide pod grant.
 *   - kube-state-metrics (chart `observability.kubeStateMetrics`, scraped by VictoriaMetrics) via PromQL
 *     (`KSM_PROMQL`): node allocatable vs the summed effective pod requests, and OOM kills from each
 *     container's last termination. Off by config → `not_measured`; on but no series → `not_measured`
 *     with the reason (not scraped yet / scrape failing). Never "healthy" on a missing source.
 *   - VictoriaMetrics kubelet_stats (via the Collector): node memory use now and its 1 h minimum,
 *     node CPU cores now and 1 h average — `CAPACITY_PROMQL`.
 *   - The run store (`agent_runs` database): `readRunQueue`.
 *   - Model gateway 429 / timeouts: NOT MEASURED. os-ui reads LiteLLM's spend and key APIs, but no
 *     source it reads counts rate-limited or timed-out calls per hour; the card says so.
 *   - One result is shared for 30 s (`ttlMemo`): every Platform page load and MCP overview call does
 *     not hit VictoriaMetrics and Postgres again.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { promInstant } from '@core/adapters/victoria-metrics/query';
import { agentRunsPool, configuredAgentRunsDatabaseUrl } from '@core/adapters/postgres/pool';
import { readRunQueue } from '@tabs/monitoring/lib/adapters/run-queue';
import {
  assessCapacity,
  CAPACITY_PROMQL,
  foldKsmCapacity,
  foldKsmOomKills,
  foldNodeUsage,
  KSM_PROMQL,
  resolveThresholds,
  ttlMemo,
  type CapacityAssessment,
  type ModelGateway,
  type NodeCapacity,
  type NodeUsage,
  type OomKill,
  type RunQueue,
  type Sample,
  type Signal,
} from '@tabs/monitoring/lib/capacity-core';

const MODEL_GATEWAY_NOT_MEASURED =
  'os-ui has no read path that counts rate-limited (429) or timed-out model calls per hour: LiteLLM is read for spend and keys only, and its Prometheus metrics are not scraped in this install.';

const CACHE_MS = 30_000;

type Keys = keyof typeof KSM_PROMQL;

/** Every kube-state-metrics query at once; the first failure makes the whole read unavailable. */
async function readKsm(): Promise<{ ok: true; s: Record<Keys, Sample[]> } | { ok: false; reason: string }> {
  const keys = Object.keys(KSM_PROMQL) as Keys[];
  const answers = await Promise.all(keys.map((k) => promInstant(KSM_PROMQL[k])));
  const s = {} as Record<Keys, Sample[]>;
  for (let i = 0; i < keys.length; i++) {
    const r = answers[i];
    if (!r.ok) return { ok: false, reason: `VictoriaMetrics: ${r.detail}` };
    s[keys[i]] = r.value;
  }
  return { ok: true, s };
}

async function readCluster(): Promise<{ nodes: Signal<NodeCapacity[]>; oomKills: Signal<OomKill[]> }> {
  if (!config.kubeStateMetricsEnabled) {
    const off = { state: 'not_measured' as const, reason: 'kube-state-metrics is off on this install (observability.kubeStateMetrics.enabled=false, or observability is off)' };
    return { nodes: off, oomKills: off };
  }
  const r = await readKsm();
  if (!r.ok) return { nodes: { state: 'unavailable', reason: r.reason }, oomKills: { state: 'unavailable', reason: r.reason } };
  if (r.s.allocatable.length === 0) {
    const none = { state: 'not_measured' as const, reason: 'VictoriaMetrics holds no kube-state-metrics series: it is not scraped yet, or the scrape of kube-state-metrics:8080 fails' };
    return { nodes: none, oomKills: none };
  }
  return { nodes: { state: 'live', value: foldKsmCapacity(r.s) }, oomKills: { state: 'live', value: foldKsmOomKills(r.s) } };
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

/** One fresh read of every signal, then the verdict (uncached). */
export async function readCapacity(nowMs = Date.now()): Promise<CapacityAssessment> {
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

/** The capacity verdict, shared for 30 s across the Platform view and the MCP overview. */
export const collectCapacity: () => Promise<CapacityAssessment> = ttlMemo(() => readCapacity(), CACHE_MS);
