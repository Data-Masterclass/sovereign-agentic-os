/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Components & System — the self-heal + node/pool augmentation over the existing
 * native component registry (`lib/platform.ts`). The route reads live component
 * status from `lib/platform.ts` (k8s) and merges these signals:
 *  - self-heal: restart counts / CrashLoop / last-healed (from
 *    `monitoring-and-healing.md`'s L1 Kubernetes + L2 Argo self-heal);
 *  - node/pool view: the single-node demo's node + pool min/max.
 *
 * Pure (live signals are injected by the route from k8s/Prometheus where
 * available); unit-testable. Toggles act only on already-provisioned workloads
 * (no provisioning).
 */

export type SelfHeal = {
  /** Pod restarts in the last window (Kubernetes liveness/readiness heals). */
  restarts: number;
  /** Whether Argo CD reverted drift recently (L2 self-heal). */
  argoSelfHealed: boolean;
  state: 'healthy' | 'healing' | 'degraded';
  note: string;
};

export type NodeView = {
  name: string;
  ready: boolean;
  role: string;
  cpu: string;
  mem: string;
  pods: number;
};

export type Pool = { name: string; min: number; max: number; current: number; autoRepair: boolean };

/** Deterministic self-heal signal per component (offline demo). A couple of
 * components show a recent heal so "a pod self-healing" is visible in the gate. */
export function selfHealFor(componentId: string, status: string): SelfHeal {
  if (status === 'starting') {
    return { restarts: 2, argoSelfHealed: false, state: 'healing', note: 'Liveness probe restarted the pod; rescheduling.' };
  }
  if (componentId === 'opensearch') {
    return { restarts: 1, argoSelfHealed: true, state: 'healthy', note: 'Argo CD reverted a manual edit; pod healthy.' };
  }
  if (status === 'off' || status === 'disabled') {
    return { restarts: 0, argoSelfHealed: false, state: 'degraded', note: 'Optional layer disabled by an Admin.' };
  }
  return { restarts: 0, argoSelfHealed: false, state: 'healthy', note: 'Steady; Kubernetes maintaining desired replicas.' };
}

export function nodes(): NodeView[] {
  return [{ name: 'kind-control-plane', ready: true, role: 'control-plane,worker', cpu: '4', mem: '12Gi', pods: 38 }];
}

export function pools(): Pool[] {
  return [{ name: 'default-pool', min: 1, max: 1, current: 1, autoRepair: true }];
}

/** Deployed version per component (the "versions" column the Admin Console
 * shows; in a real deploy these come from the Helm release / image tags). */
const VERSIONS: Record<string, string> = {
  litellm: 'v1.55.3', langfuse: 'v3.22.0', opa: 'v0.70.0', opensearch: 'v2.17.1',
  postgres: 'CNPG 1.24', clickhouse: 'v24.8', minio: 'RELEASE.2026-05', valkey: 'v8.0',
  dagster: 'v1.9.1', cube: 'v1.1', superset: 'v4.1', forgejo: 'v10.0', argocd: 'v2.13',
  'mock-model': 'v0.1', 'query-tool': 'v0.3', polaris: 'v0.9', haystack: 'v2.8',
  mlflow: 'v2.18', jupyterhub: 'v5.2', 'os-ui': 'v1.0.0',
};

export function versionFor(id: string): string {
  return VERSIONS[id] ?? 'n/a';
}

/** Optional layers the Admin can enable/disable per the component registry. */
export const OPTIONAL_LAYERS = ['Layer 4 — Science'];
