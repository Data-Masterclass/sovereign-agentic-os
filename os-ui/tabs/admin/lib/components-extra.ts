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
  dagster: 'v1.13.11',   // images/extensions/dagster/Dockerfile pins dagster==1.13.11
  'mock-model': 'v0.1.1', 'query-tool': 'v0.4', polaris: 'v1.1.0-incubating', haystack: 'v2.8',
  trino: '476', 'data-runner': 'v0.1.0',
  mlflow: 'v2.19', jupyterhub: 'v5.2', 'os-ui': 'v0.5.14',
};

export function versionFor(id: string): string {
  return VERSIONS[id] ?? 'n/a';
}

/** Optional layers the Admin can enable/disable per the component registry. */
export const OPTIONAL_LAYERS = ['Layer 4 — Science'];

/**
 * Trino access-rules reconciler — the Platform -> Components & Health row (B3-review-H-4).
 *
 * The reconciler is fail-soft by design: it never throws and never blocks a write. That used to
 * mean a failure was one `console.warn` nobody reads, with the chart's PERMISSIVE bootstrap left
 * in force. This turns the last outcome into a visible signal:
 *   • never attempted (flag on, nothing recorded yet) -> amber;
 *   • last attempt failed -> RED, with the stable `code` so the note says what to fix;
 *   • last attempt succeeded but is older than TWICE the repair interval -> RED, because the
 *     periodic pass should have refreshed it and silence means the loop itself is gone;
 *   • otherwise green.
 * PURE — the route injects the outcome and the clock. Off (`enabled: false`) returns null, so a
 * deployment with the feature off grows no row.
 */
export type AccessRulesOutcome = { ok: boolean; code: string; detail: string; at: number };

export type AccessRulesRow = {
  id: 'trino-access-rules';
  name: string;
  health: 'green' | 'amber' | 'red';
  detail: string;
  /** When the recorded outcome happened (epoch ms); absent before the first attempt. */
  at?: number;
};

export function trinoAccessRulesRow(input: {
  enabled: boolean;
  outcome: AccessRulesOutcome | null;
  now: number;
  /** The reconciler's repair cadence in ms; staleness is 2x this. */
  periodMs: number;
}): AccessRulesRow | null {
  if (!input.enabled) return null;
  const base = { id: 'trino-access-rules' as const, name: 'Trino access rules' };
  if (!input.outcome) {
    return { ...base, health: 'amber', detail: 'Not reconciled yet — the chart bootstrap is in force (impersonation bounded by id shape, ownership open).' };
  }
  const { ok, code, detail, at } = input.outcome;
  if (!ok) {
    return { ...base, health: 'red', at, detail: `Last reconcile FAILED (${code}): ${detail}. The chart bootstrap is in force — ownership is open until this succeeds.` };
  }
  const ageMs = input.now - at;
  if (input.periodMs > 0 && ageMs > 2 * input.periodMs) {
    return {
      ...base,
      health: 'red',
      at,
      detail: `Last successful reconcile was ${Math.round(ageMs / 60000)} min ago — more than twice the ${Math.round(input.periodMs / 60000)} min repair interval. The reconcile loop is not running.`,
    };
  }
  return { ...base, health: 'green', at, detail: `Reconciled (${code}): ${detail}` };
}

/**
 * Git mirror — the Platform → Components & Health row (engine rebuild Part D, checklist X2).
 *
 * The push after a commit is fire-and-forget by design: it must never block a save. That used to
 * mean a failure was one `console.warn` nobody reads, with the remote silently behind. This turns
 * the last recorded outcome of every configured mirror into one visible signal:
 *   • git off, or no mirror configured anywhere -> no row (a deployment without the feature grows
 *     nothing);
 *   • a mirror configured but never pushed -> amber (nothing has been committed yet, or the very
 *     first push has not happened);
 *   • any mirror whose LAST outcome is an error -> RED, naming the domains and the first error;
 *   • a mirror whose last success is older than the oldest local commit cannot be detected here
 *     (the row reads status, not the repo), so a stale-but-successful mirror stays green and the
 *     detail states when it last pushed — say what is known, never imply more.
 * PURE — the route injects the signals and the clock.
 */
export type MirrorSignalRow = {
  domain: string;
  url: string;
  lastSha?: string;
  lastPushedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
};

export type GitMirrorRow = {
  id: 'git-mirror';
  name: string;
  health: 'green' | 'amber' | 'red';
  detail: string;
  /** When the newest recorded outcome happened (epoch ms); absent before the first push. */
  at?: number;
};

/** The host of a mirror URL (never its path or any credential — the setter forbids those). */
function mirrorHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable url)';
  }
}

export function gitMirrorRow(input: { enabled: boolean; signals: MirrorSignalRow[]; now: number }): GitMirrorRow | null {
  if (!input.enabled || input.signals.length === 0) return null;
  const base = { id: 'git-mirror' as const, name: 'Git mirror (domain repositories)' };
  const times = input.signals
    .flatMap((s) => [s.lastErrorAt, s.lastPushedAt])
    .filter((t): t is string => typeof t === 'string' && Date.parse(t) > 0)
    .map((t) => Date.parse(t));
  const at = times.length > 0 ? Math.max(...times) : undefined;
  const failing = input.signals.filter((s) => s.lastError);
  if (failing.length > 0) {
    const first = failing[0];
    return {
      ...base,
      health: 'red',
      ...(at ? { at } : {}),
      detail:
        `Last push FAILED for ${failing.map((s) => s.domain).join(', ')} — ${mirrorHost(first.url)}: ${first.lastError}. ` +
        'The commit is safe in the OS-side repository; the remote is behind and the next commit retries the push.',
    };
  }
  const never = input.signals.filter((s) => !s.lastPushedAt);
  if (never.length === input.signals.length) {
    return { ...base, health: 'amber', detail: `Configured for ${input.signals.map((s) => s.domain).join(', ')} but nothing has been pushed yet (no commit since it was configured).` };
  }
  const pushed = input.signals.filter((s) => s.lastPushedAt);
  const detail =
    `${pushed.length} of ${input.signals.length} mirror(s) pushed — ` +
    pushed.map((s) => `${s.domain} → ${mirrorHost(s.url)} @ ${(s.lastSha ?? '').slice(0, 7)} (${s.lastPushedAt})`).join('; ') +
    (never.length > 0 ? `; awaiting a first push: ${never.map((s) => s.domain).join(', ')}` : '');
  return { ...base, health: never.length > 0 ? 'amber' : 'green', ...(at ? { at } : {}), detail };
}
