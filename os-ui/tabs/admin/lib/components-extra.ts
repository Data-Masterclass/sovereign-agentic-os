/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Components & System — the rows the Platform page adds beside the component registry
 * (`lib/platform.ts`). Versions, health, restarts and nodes are NOT here: they are read live from
 * each component and from Kubernetes (`component-health.ts`, `cluster-nodes.ts`; design 00 §6,
 * WP-05). The typed-in self-heal, node, pool and version tables that used to stand here were
 * deleted: they showed a node and restart counts that did not exist.
 *
 * Pure: the route injects every live signal; unit-testable.
 */

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
    // RED, not amber (B4-review E-2). "Not reconciled yet" is not a warm-up state to be patient
    // about: until the first success, the chart's permissive bootstrap IS the access-control file,
    // so table ownership is open and the install is effectively OPA-only. A reconciler that never
    // succeeds stays in exactly this state forever, and amber is how that goes unnoticed.
    return {
      ...base,
      health: 'red',
      detail:
        'NOT reconciled yet — the chart bootstrap is in force: impersonation is bounded only by principal-id SHAPE and table ownership is OPEN, so this install is governed by OPA alone. ' +
        'If this persists past the first minutes, the reconciler is not reaching the cluster: check that the os-ui Role grants get+patch on the trino-access-rules ConfigMap and that the ConfigMap exists.',
    };
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

/**
 * Data products / git — the Platform → Components & Health row (B4 review M-8).
 *
 * `gitMirrorRow` disappears when the feature is off, which is right for a MIRROR (a deployment
 * that configured none should grow no row). It is wrong for the FEATURE: with
 * `DATA_PROJECT_GIT` off, B4 left the OS with no scheduler at all — a saved sync cadence is
 * never triggered by anything — and an ABSENT row reads as "nothing to see here". So this row
 * exists in both states and says which one the install is in:
 *   • on  -> green, naming who schedules and where the schedules live;
 *   • off -> AMBER, "scheduling disabled", with what still works (manual "Sync now", the OS's own
 *     CTAS execution) and what does not.
 * Amber, not red: the opt-out is a legitimate configuration, not a fault.
 * PURE — the route injects the flag.
 */
export type DataProductsGitRow = {
  id: 'data-products-git';
  name: string;
  health: 'green' | 'amber';
  state: 'on' | 'off';
  detail: string;
};

export function dataProductsGitRow(input: { enabled: boolean }): DataProductsGitRow {
  const base = { id: 'data-products-git' as const, name: 'Data products (git + Dagster)' };
  if (!input.enabled) {
    return {
      ...base,
      health: 'amber',
      state: 'off',
      detail:
        'DATA_PROJECT_GIT is OFF — scheduling disabled. No dbt project is committed, and no saved sync cadence is ' +
        'triggered by anything: engine rebuild B4 removed the per-dataset CronJobs and the sweep routes, so the ' +
        'only way to refresh a dataset is "Sync now". The OS still executes transforms and quality checks itself.',
    };
  }
  return {
    ...base,
    health: 'green',
    state: 'on',
    detail:
      'On — every data mutation commits to its domain repository, and Dagster runs the schedules declared in ' +
      'os/schedules.yml (UTC) against the validated commit.',
  };
}
