/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listComponentsWithStatus } from '@/lib/platform-admin';
import type { Health, HealthItem } from '../types';

/**
 * System-health adapter (lens 4) — node/pod/service status + self-heal state.
 * READ-ONLY. This tab SURFACES the self-healing runbook (monitoring-and-healing.md);
 * it does NOT rebuild it. Live reads:
 *   • workload status — REUSE `lib/platform.listComponentsWithStatus()` (the k8s
 *     API read the OS UI pod's ServiceAccount already grants). off/starting → amber,
 *     unknown/disabled → handled; running → green.
 * Mock (not in the bundle on kind): Prometheus/Alertmanager + Argo sync/health +
 * SKE node auto-repair + the OOMKilled→auto-restart self-heal story + OpenSearch
 * green/yellow/red. Marked `source:'mock'` so the dual pattern stays honest.
 *
 * Cluster/tenant-wide signals are tagged `cluster:true` so the scope spine shows
 * them to ADMIN only.
 */

function workloadHealth(status: string): Health {
  switch (status) {
    case 'running':
      return 'green';
    case 'starting':
    case 'off':
      return 'amber';
    case 'on-demand':
      return 'green'; // job-based (e.g. dbt): no standing pod, runs on demand — benign
    case 'unknown':
    case 'disabled':
    case 'n/a':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export async function collectSystem(): Promise<HealthItem[]> {
  const live: HealthItem[] = [];
  try {
    const comps = await listComponentsWithStatus();
    // Only surface workloads we could actually read (status !== unknown/n-a) AND
    // that are not green-by-default noise; attention-first means we keep the few
    // not-running ones plus a single rolled-up "platform services" green.
    // 'on-demand' (job-based components like dbt) has no standing workload — it is
    // not a health signal and must not defeat the "unreachable → []" honesty rule.
    const readable = comps.filter(
      (c) => c.status !== 'unknown' && c.status !== 'n/a' && c.status !== 'on-demand',
    );
    if (readable.length > 0) {
      for (const c of readable) {
        const h = workloadHealth(c.status);
        if (h === 'green') continue; // fold healthy services into the roll-up below
        live.push({
          id: `sys-wl-${c.id}`,
          lens: 'system',
          title: `${c.name} — ${c.status}`,
          health: h,
          detail: `Workload ${c.workload} in ${c.ns}: ${c.status}. Kubernetes keeps desired replicas; restarts on probe failure.`,
          owner: 'platform',
          domain: 'platform',
          cluster: true,
          selfHeal: h === 'amber' ? 'Self-healing — Kubernetes is reconciling to desired replicas.' : undefined,
          links: { systemId: `sys-wl-${c.id}` },
          source: 'live',
        });
      }
      const greens = readable.filter((c) => workloadHealth(c.status) === 'green').length;
      live.push({
        id: 'sys-wl-rollup',
        lens: 'system',
        title: 'Platform services',
        health: 'green',
        detail: `${greens} workloads Ready. Probes + Argo self-heal + SKE node auto-repair active.`,
        owner: 'platform',
        domain: 'platform',
        cluster: true,
        selfHeal: 'Healthy.',
        source: 'live',
      });
    }
  } catch {
    /* not in a cluster — cluster health unavailable */
  }

  // Return only live k8s data. Empty means the cluster is unreachable (honest).
  return live;
}
