/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    System-health adapter (lens 4) — workload status from the Kubernetes API
 * USER STORY: As a platform admin I want the platform's workloads that are not running listed,
 *             with the healthy ones rolled up, so that I see cluster trouble at a glance.
 * ARCHITECTURE:
 *   - Server-only, read-only; reuses `listComponentsWithStatus()` from `@tabs/admin/lib`.
 *     Called by `app/api/platform-admin/components/route.ts`, not by the Monitoring overview.
 *   - running/on-demand → green, starting/off → amber, unknown/disabled/n/a → unknown;
 *     on-demand (job-based) components are not counted as a signal.
 *   - Every item is `cluster: true` (admin-only under the scope filter). No mock path: an
 *     unreachable cluster returns `[]`.
 */
import 'server-only';
import { listComponentsWithStatus } from '@tabs/admin/lib/index';
import type { Health, HealthItem } from '@tabs/monitoring/lib/types';

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
        detail: `${greens} workloads Ready. Probes + SKE node auto-repair active; there is no GitOps controller, so configuration drift is not reverted automatically.`,
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
