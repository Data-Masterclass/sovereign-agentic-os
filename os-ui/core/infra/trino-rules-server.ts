/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reconcile Trino's `rules.json` ConfigMap from OS domain membership
 * USER STORY: As a platform owner I want adding a user to a domain to make that domain's Iceberg
 *             schema writable for them, and removing them to take it away — without a Helm upgrade
 *             and without the OS holding a second, divergent copy of the rule.
 * ARCHITECTURE:
 *   - The chart renders a BOOTSTRAP `trino-access-rules` ConfigMap (impersonation by id pattern,
 *     nothing ownable) so a fresh install is safe before the OS has said anything. This module
 *     overwrites the SAME key with the enumerated rules, and Trino re-reads the file on its
 *     `security.refresh-period` — no pod restart, no roll.
 *   - PATCH only when the rendered bytes changed, so boot and a membership change are both cheap and
 *     the ConfigMap's resourceVersion does not churn.
 *   - THREE triggers, all through `startTrinoRulesReconciler` (B3-review-H-2/H-3/H-4):
 *       boot      — once, as soon as the process has a directory to read;
 *       event     — every user/domain/membership write, debounced and serialised, so a bulk import
 *                   is one reconcile and two rapid writes are one reconcile;
 *       Every failure code is retried, `no-cluster` and `no-configmap` included (B4-review E-2):
 *       at boot those are RBAC propagation and Helm's object ordering, not permanent facts.
 *       periodic  — every `periodMs` (default 10 min, jittered), because `helm upgrade` rewrites
 *                   Helm's BOOTSTRAP value over the OS's enumerated one and no OS event fires for
 *                   that. The periodic pass is a GET + byte compare when nothing drifted, so the
 *                   cost of holding the invariant is one read every ten minutes.
 *   - Fail-soft, but no longer silent: every failure is a typed outcome with a stable `code`, is
 *     retried with backoff, and the LAST outcome is readable (`lastReconcileOutcome`) so the
 *     Platform -> Components & Health surface can show a red row instead of a warn line nobody
 *     reads. The rules file is a NARROWING layer chained after OPA, so a stale file is never an
 *     opening — but a stale file does mean the bootstrap's open ownership is what Trino enforces.
 *   - Writes no secret: `buildTrinoRules` emits identifiers and regexes only.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s, type K8sResult } from '@core/infra/k8s';
import { buildTrinoRules, renderTrinoRules, type RulesInput } from '@core/infra/trino-rules';

/** The ConfigMap the chart renders and Trino mounts at `/etc/trino/rules.json`. */
export const RULES_CONFIGMAP = 'trino-access-rules';
export const RULES_KEY = 'rules.json';

/** Stable, machine-readable reason — what the health row and the logs key off. */
export type ReconcileCode =
  | 'written'
  | 'unchanged'
  | 'no-cluster'
  | 'no-configmap'
  | 'forbidden'
  | 'get-failed'
  | 'patch-failed'
  | 'threw';

export type ReconcileOutcome =
  | { ok: true; changed: boolean; code: 'written' | 'unchanged'; detail: string; at: number }
  | { ok: false; changed: false; code: Exclude<ReconcileCode, 'written' | 'unchanged'>; detail: string; at: number };

export type RulesK8s = (method: string, path: string, body?: unknown) => Promise<K8sResult>;

function cmPath(ns: string): string {
  return `/api/v1/namespaces/${ns}/configmaps/${RULES_CONFIGMAP}`;
}

/**
 * Write the rules for `input` into the ConfigMap. Returns what happened; never throws.
 */
export async function reconcileTrinoAccessRules(
  input: RulesInput,
  opts: { namespace?: string; k8s?: RulesK8s; now?: () => number } = {},
): Promise<ReconcileOutcome> {
  const ns = opts.namespace ?? config.platformNamespace;
  const call = opts.k8s ?? k8s;
  const at = (opts.now ?? Date.now)();
  const bad = (code: Exclude<ReconcileCode, 'written' | 'unchanged'>, detail: string): ReconcileOutcome =>
    record({ ok: false, changed: false, code, detail, at });
  const desired = renderTrinoRules(buildTrinoRules(input));

  const get = await call('GET', cmPath(ns));
  if (get.status === 0) return bad('no-cluster', 'no Kubernetes API reachable (not running in a cluster)');
  if (get.status === 404) return bad('no-configmap', `ConfigMap ${RULES_CONFIGMAP} does not exist — enable trino.accessControl in the chart`);
  if (get.status === 403) return bad('forbidden', `forbidden: the os-ui ServiceAccount may not read ${RULES_CONFIGMAP}`);
  if (get.status < 200 || get.status >= 300) return bad('get-failed', `GET ${RULES_CONFIGMAP} → ${get.status}`);

  const data = (get.body.data ?? {}) as Record<string, string>;
  if (data[RULES_KEY] === desired) return record({ ok: true, changed: false, code: 'unchanged', detail: 'rules already current', at });

  const patch = await call('PATCH', cmPath(ns), { data: { [RULES_KEY]: desired } });
  if (patch.status < 200 || patch.status >= 300) return bad('patch-failed', `PATCH ${RULES_CONFIGMAP} → ${patch.status}`);
  return record({
    ok: true,
    changed: true,
    code: 'written',
    detail: `${input.domains.length} domain(s), ${input.personalLanes.length} personal lane(s); Trino re-reads within security.refresh-period`,
    at,
  });
}

// ----------------------------------------------------------------- last outcome --

let last: ReconcileOutcome | null = null;

function record(out: ReconcileOutcome): ReconcileOutcome {
  last = out;
  return out;
}

/** The most recent reconcile result in this process, or null before the first attempt. */
export function lastReconcileOutcome(): ReconcileOutcome | null {
  return last;
}

/** Test seam — the module-level record is process-wide by design. */
export function _resetReconcileOutcome(): void {
  last = null;
}

// ------------------------------------------------------------------- scheduler --

/** Default cadence of the repair pass (ms). Mirrors `trino.accessControl.reconcileIntervalMinutes`. */
export const DEFAULT_RECONCILE_PERIOD_MS = 10 * 60 * 1000;

export type ReconcilerOptions = {
  /** Reads the CURRENT directory facts. Called once per pass, never cached. */
  resolve: () => Promise<RulesInput>;
  /** Collapse a burst of writes into one pass. */
  debounceMs?: number;
  /** Repair pass cadence; 0 disables it (tests, and an operator who wants event-only). */
  periodMs?: number;
  /** Up to this much random delay is added to each periodic pass, so replicas do not synchronise. */
  jitterMs?: number;
  /** Attempts per pass, including the first. */
  attempts?: number;
  /** First retry delay; doubles per attempt, capped at `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  reconcile?: (input: RulesInput) => Promise<ReconcileOutcome>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  random?: () => number;
};

export type ReconcilerHandle = {
  /** Ask for a pass. Debounced and serialised; returns immediately. */
  trigger(reason: string): void;
  /** Resolves when no pass is in flight and no debounce is pending (tests). */
  idle(): Promise<void>;
  stop(): void;
  /** The cadence in force, so a health row can call a stale outcome stale. */
  periodMs: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Own the three triggers. ONE pass runs at a time; a trigger arriving mid-pass sets a pending flag
 * so exactly one further pass follows (never a queue of them), which is what makes a bulk
 * membership import cheap. Failures are retried inside the pass with exponential backoff and then
 * recorded — a caller never awaits, and nothing throws out of here.
 */
export function startTrinoRulesReconciler(opts: ReconcilerOptions): ReconcilerHandle {
  const debounceMs = opts.debounceMs ?? 2000;
  const periodMs = opts.periodMs ?? DEFAULT_RECONCILE_PERIOD_MS;
  const jitterMs = opts.jitterMs ?? Math.min(30_000, Math.floor(periodMs / 10));
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 2000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const run = opts.reconcile ?? ((input: RulesInput) => reconcileTrinoAccessRules(input));
  const log = opts.log ?? ((level, message) => (level === 'info' ? console.info(message) : console.warn(message)));
  const random = opts.random ?? Math.random;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;
  let pendingReason: string | null = null;
  let stopped = false;

  async function pass(reason: string): Promise<void> {
    for (let i = 1; i <= attempts; i++) {
      let out: ReconcileOutcome;
      try {
        out = await run(await opts.resolve());
      } catch (err) {
        out = record({
          ok: false,
          changed: false,
          code: 'threw',
          detail: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        });
      }
      if (out.ok) {
        // An unchanged periodic pass is the normal case and must not fill the log.
        if (out.changed) log('info', `[os-ui] trino access rules: written (${reason}) — ${out.detail}`);
        return;
      }
      // RETRY `no-cluster` / `no-configmap` TOO (B4-review E-2). They used to end the pass on the
      // first attempt, on the reading that they are permanent facts ("not in a cluster", "the
      // feature is off"). At BOOT they are usually transient instead: the ServiceAccount's Role
      // may not have propagated yet, and Helm does not order the ConfigMap before the Deployment.
      // Ending the pass there left the chart's permissive bootstrap in force until the periodic
      // repair came round — up to `reconcileIntervalMinutes` (10 by default) of open ownership.
      // Now every failure code gets the pass's backoff; a genuinely cluster-less process (a
      // laptop, the test suite) pays `attempts` short sleeps once and then the same single
      // warning, and the periodic repair remains the long-horizon retry it always was.
      if (i === attempts) {
        log('warn', `[os-ui] trino access rules NOT reconciled after ${i} attempt(s) (${reason}, ${out.code}) — the chart bootstrap still applies: ${out.detail}`);
        return;
      }
      await sleep(Math.min(maxBackoffMs, backoffMs * 2 ** (i - 1)));
      if (stopped) return;
    }
  }

  function kick(reason: string): void {
    if (stopped) return;
    if (inflight) {
      pendingReason = reason;
      return;
    }
    inflight = (async () => {
      await pass(reason);
      inflight = null;
      const next = pendingReason;
      pendingReason = null;
      if (next && !stopped) kick(next);
    })();
  }

  const handle: ReconcilerHandle = {
    trigger(reason: string) {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        kick(reason);
      }, debounceMs);
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref(): void }).unref();
    },
    async idle() {
      for (let i = 0; i < 1000; i++) {
        if (!timer && !inflight && !pendingReason) return;
        await sleep(1);
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      timer = null;
      interval = null;
    },
    periodMs,
  };

  // Boot pass: immediate, not debounced — the bootstrap file is open until it lands.
  kick('boot');

  if (periodMs > 0) {
    interval = setInterval(() => {
      const wait = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
      const t = setTimeout(() => kick('periodic repair (a helm upgrade rewrites the bootstrap)'), wait);
      if (typeof t === 'object' && t && 'unref' in t) (t as { unref(): void }).unref();
    }, periodMs);
    if (typeof interval === 'object' && interval && 'unref' in interval) (interval as { unref(): void }).unref();
  }

  return handle;
}
