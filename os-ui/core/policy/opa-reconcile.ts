/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Restore all runtime OPA state from the OS's own records — at boot, every five
 *             minutes, and as soon as an OPA restart is detected.
 * USER STORY: As a user in any domain I want my agents to keep working after OPA restarts, so a
 *             release or a pod roll never leaves every non-seeded domain refused ("not granted").
 *             As an operator I want Monitoring to say "policy state not restored" whenever the
 *             restore did not complete, never a silent failure.
 * ARCHITECTURE:
 *   - OPA keeps REST-pushed data in memory only; a restart reloads the chart files and loses
 *     everything os-ui pushed (grants, governance principals/tables, approval holds, guardrail
 *     policies). Each tab registers a SOURCE that re-derives its part from its own store and
 *     writes it with `publishOpa` (the same function its change path uses). Registration happens
 *     in `instrumentation.ts`, so the kernel never imports a tab.
 *   - Grants are ONE document (`PUT /v1/data/grants`, a whole-document replace), so they are
 *     composed here: the admin compile is the base, unioned with core access grants and every
 *     registered grant CONTRIBUTOR (agent systems). A failed contributor refuses the write rather
 *     than publishing a document that silently drops its grants.
 *   - Restart detection: OPA's `GET /health` plus a canary document (`os_state/reconciled`) written
 *     last by every successful reconcile. Healthy but canary undefined ⇒ OPA lost its state ⇒
 *     reconcile now. Unhealthy ⇒ status "not restored".
 *   - Idempotent (every write is an upsert), single-flight, web process only (`process-role.ts`).
 *   - Never silent: a reconciler that has not completed one run 2 min after boot is reported
 *     `not-restored` too (Monitoring alert), and the run worker holds runs while the canary is
 *     missing (`worker-loop.ts` policy gate).
 *   - Interim until WP-11 (OPA bundles) makes OPA load this state itself.
 */
import { isRunWorkerProcess } from '@core/kernel/process-role';
import { scheduleEvery } from '@core/reconcile/runtime';
import { opaHealthy, publishOpa, readOpaData, type OpaWriteResult } from '@core/policy/opa-publish';
import { activeAccessGrants } from '@core/policy/policy-view';

import { OPA_CANARY_PATH } from '@core/policy/opa-canary';
export { OPA_CANARY_PATH };

export type OpaSourceResult = { ok: boolean; detail: string };
export type OpaStateSource = { name: string; restore(): Promise<OpaSourceResult> };
export type GrantContributor = { name: string; grants(): Promise<Record<string, string[]>> };

export type OpaReconcileStatus = {
  /** `restored` = the last reconcile wrote every source and the canary. */
  state: 'never-run' | 'restored' | 'not-restored';
  reason?: string;
  at?: string;
  lastRestoredAt?: string;
  detail: string;
  sources: { name: string; ok: boolean; detail: string }[];
};

type Registry = {
  sources: Map<string, OpaStateSource>;
  contributors: Map<string, GrantContributor>;
  status: OpaReconcileStatus;
  inflight: Promise<OpaReconcileStatus> | null;
  stop: (() => void) | null;
};

const KEY = Symbol.for('soa.policy.opa-reconcile');
function reg(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  if (!g[KEY]) {
    g[KEY] = {
      sources: new Map(),
      contributors: new Map(),
      status: { state: 'never-run', detail: 'Policy state has not been restored yet.', sources: [] },
      inflight: null,
      stop: null,
    };
  }
  return g[KEY]!;
}

export function registerOpaStateSource(src: OpaStateSource): void {
  reg().sources.set(src.name, src);
}
export function registerGrantContributor(c: GrantContributor): void {
  reg().contributors.set(c.name, c);
}
/** How long after process start a never-run reconciler counts as "not restored". */
export const NEVER_RUN_GRACE_MS = 2 * 60_000;

/**
 * The reconciler's status for Monitoring. A reconciler that has not completed a single run
 * `NEVER_RUN_GRACE_MS` after os-ui started (it failed to start, or every run is still hanging)
 * is reported as `not-restored`, so that case raises the alert instead of staying silent.
 */
export function opaReconcileStatus(uptimeMs = process.uptime() * 1000): OpaReconcileStatus {
  const s = reg().status;
  if (s.state === 'never-run' && uptimeMs >= NEVER_RUN_GRACE_MS) {
    return {
      ...s,
      state: 'not-restored',
      reason: 'never-run',
      detail: `no policy-state reconcile has completed in the ${Math.round(uptimeMs / 60_000)} min since os-ui started — the reconciler may not have started (see the os-ui log for "opa state")`,
    };
  }
  return s;
}

function union(into: Record<string, string[]>, add: Record<string, string[]>): void {
  for (const [p, tools] of Object.entries(add)) into[p] = [...new Set([...(into[p] ?? []), ...tools])].sort();
}

/**
 * Compose the WHOLE grants document and publish it (`PUT /v1/data/grants`). `base` is the admin
 * compile (users + domains). Every runtime grant writer that replaces the document goes through
 * here, so a recompile can no longer drop an agent system's or an access request's grants.
 */
export async function publishGrantsDocument(base: Record<string, string[]>): Promise<OpaWriteResult & { principals: number }> {
  const doc: Record<string, string[]> = {};
  union(doc, base);
  const access: Record<string, string[]> = {};
  for (const g of activeAccessGrants()) (access[g.principal] ??= []).push(g.tool);
  union(doc, access);
  for (const c of reg().contributors.values()) {
    try {
      union(doc, await c.grants());
    } catch (err) {
      const detail = `grants not published: contributor "${c.name}" failed — ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, status: null, detail, principals: 0 };
    }
  }
  const r = await publishOpa({ kind: 'data', path: 'grants', value: doc });
  return { ...r, principals: Object.keys(doc).length };
}

function setStatus(s: OpaReconcileStatus): OpaReconcileStatus {
  reg().status = s;
  if (s.state === 'restored') {
    console.info(`[os-ui] opa state: restored (${s.reason}) — ${s.sources.map((x) => `${x.name}: ${x.detail}`).join('; ')}`);
  } else {
    console.error(`[os-ui] opa state: POLICY STATE NOT RESTORED (${s.reason}) — ${s.detail}`);
  }
  return s;
}

async function runReconcile(reason: string): Promise<OpaReconcileStatus> {
  const r = reg();
  const at = new Date().toISOString();
  const lastRestoredAt = r.status.lastRestoredAt;
  if (r.sources.size === 0) {
    return setStatus({ state: 'not-restored', reason, at, lastRestoredAt, detail: 'no policy-state sources are registered', sources: [] });
  }
  if (!(await opaHealthy())) {
    return setStatus({ state: 'not-restored', reason, at, lastRestoredAt, detail: 'OPA is unreachable (GET /health failed)', sources: [] });
  }
  const sources: OpaReconcileStatus['sources'] = [];
  for (const src of r.sources.values()) {
    try {
      const out = await src.restore();
      sources.push({ name: src.name, ok: out.ok, detail: out.detail });
    } catch (err) {
      sources.push({ name: src.name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const failed = sources.filter((s) => !s.ok);
  if (failed.length > 0) {
    return setStatus({
      state: 'not-restored', reason, at, lastRestoredAt, sources,
      detail: failed.map((f) => `${f.name}: ${f.detail}`).join('; '),
    });
  }
  // The canary goes LAST: its presence means every source above was written to THIS OPA process.
  const canary = await publishOpa({ kind: 'data', path: OPA_CANARY_PATH, value: { at, reason } });
  if (!canary.ok) {
    return setStatus({ state: 'not-restored', reason, at, lastRestoredAt, sources, detail: canary.detail });
  }
  return setStatus({ state: 'restored', reason, at, lastRestoredAt: at, sources, detail: `${sources.length} source(s) restored` });
}

/** Restore every registered source now. Single-flight: concurrent callers share one run. */
export function reconcileOpaState(reason: string): Promise<OpaReconcileStatus> {
  const r = reg();
  if (!r.inflight) {
    r.inflight = runReconcile(reason).finally(() => {
      r.inflight = null;
    });
  }
  return r.inflight;
}

/**
 * One restart probe: OPA unhealthy ⇒ "not restored"; healthy but the canary is missing (OPA
 * restarted and lost its pushed state) or the last reconcile failed ⇒ reconcile now.
 */
export async function probeOpaState(): Promise<'ok' | 'reconciled' | 'unreachable'> {
  if (!(await opaHealthy())) {
    const prev = reg().status;
    if (prev.state !== 'not-restored' || !prev.detail.startsWith('OPA is unreachable')) {
      setStatus({ state: 'not-restored', reason: 'probe', at: new Date().toISOString(), lastRestoredAt: prev.lastRestoredAt, detail: 'OPA is unreachable (GET /health failed)', sources: [] });
    }
    return 'unreachable';
  }
  const canary = await readOpaData(OPA_CANARY_PATH);
  if (!canary.reachable) return 'unreachable';
  if (!canary.defined) {
    await reconcileOpaState('opa-restart-detected');
    return 'reconciled';
  }
  if (reg().status.state !== 'restored') {
    await reconcileOpaState('retry');
    return 'reconciled';
  }
  return 'ok';
}

export type ReconcilerOptions = { periodMs?: number; probeMs?: number };

/** Start the reconciler (web process only). Idempotent; returns a stop function. */
export function startOpaReconciler(opts: ReconcilerOptions = {}): () => void {
  const r = reg();
  if (r.stop) return r.stop;
  if (isRunWorkerProcess()) {
    console.info('[os-ui] opa state: reconciler not started in the run worker (os-ui web owns it)');
    return () => {};
  }
  const periodMs = opts.periodMs ?? 5 * 60_000;
  const probeMs = opts.probeMs ?? 15_000;
  void reconcileOpaState('boot');
  const stopPeriodic = scheduleEvery('opa-state.periodic', periodMs, () => reconcileOpaState('periodic'));
  const stopProbe = scheduleEvery('opa-state.probe', probeMs, probeOpaState);
  r.stop = () => {
    stopPeriodic();
    stopProbe();
    r.stop = null;
  };
  return r.stop;
}

/** Test hook: forget sources, contributors, status and timers. */
export function __resetOpaReconcile(): void {
  const r = reg();
  r.stop?.();
  r.sources.clear();
  r.contributors.clear();
  r.inflight = null;
  r.status = { state: 'never-run', detail: 'Policy state has not been restored yet.', sources: [] };
}
