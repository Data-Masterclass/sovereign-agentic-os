/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Receive OPA's status reports and wait until an OPA instance has ACTIVATED a bundle
 *             revision (10 F3: wait on proof, not on time).
 * USER STORY: As a user starting a run I want the run to start only once every OPA that will
 *             judge it has loaded my grant, so it never fails as "no access" a second later.
 * ARCHITECTURE:
 *   - OPA's status API (https://www.openpolicyagent.org/docs/management-status): with
 *     `status: {service: osui}` each instance POSTs `<service url>/status` on every bundle
 *     activation, carrying `labels` and `bundles[<name>].active_revision`. The chart sets
 *     `labels.instance` (`opa`; the Trino sidecar in WP-12) so instances are named, not random ids.
 *   - `waitForBundleRevision` resolves when every named instance reports `active_revision` ≥ the
 *     wanted one (numeric revisions, the `grant_rev` sequence), else a typed `grant_not_propagated`
 *     after the timeout. It never pretends: no report, no success.
 *   - In memory in the web process that receives the POSTs (os-ui is one replica, design 04 §5.2).
 */

export type InstanceBundleStatus = { active_revision?: string; last_successful_activation?: string; code?: string; message?: string };
export type InstanceStatus = { instance: string; receivedAt: string; bundles: Record<string, InstanceBundleStatus> };

type Waiter = () => void;
type State = { instances: Map<string, InstanceStatus>; waiters: Set<Waiter> };
const KEY = Symbol.for('soa.policy.opa-status');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { instances: new Map(), waiters: new Set() });
}

type StatusBody = {
  labels?: Record<string, string>;
  bundles?: Record<string, { active_revision?: string; last_successful_activation?: string; code?: string; message?: string }>;
};

/** Record one OPA status report. Returns the instance name, or null when the body is not a report. */
export function recordOpaStatus(body: unknown): string | null {
  const b = body as StatusBody;
  if (!b || typeof b !== 'object' || !b.labels) return null;
  const instance = b.labels.instance || b.labels.id;
  if (!instance) return null;
  const bundles: Record<string, InstanceBundleStatus> = {};
  for (const [name, v] of Object.entries(b.bundles ?? {})) {
    bundles[name] = { active_revision: v.active_revision, last_successful_activation: v.last_successful_activation, code: v.code, message: v.message };
  }
  const s = st();
  s.instances.set(instance, { instance, receivedAt: new Date().toISOString(), bundles });
  for (const w of [...s.waiters]) w();
  return instance;
}

export function opaInstanceStatuses(): InstanceStatus[] {
  return [...st().instances.values()];
}

function atLeast(active: string | undefined, wanted: string): boolean {
  if (active === undefined) return false;
  if (/^\d+$/.test(active) && /^\d+$/.test(wanted)) return BigInt(active) >= BigInt(wanted);
  return active === wanted;
}

export type PropagationResult = { ok: true; ms: number } | { ok: false; code: 'grant_not_propagated'; detail: string };

/** Wait until every instance in `instances` reports `bundle` at revision ≥ `revision`. */
export function waitForBundleRevision(bundle: string, revision: string | number | bigint, instances: string[], timeoutMs = 10_000): Promise<PropagationResult> {
  const wanted = String(revision);
  const start = Date.now();
  const s = st();
  const done = () => instances.every((i) => atLeast(s.instances.get(i)?.bundles[bundle]?.active_revision, wanted));
  if (instances.length === 0) return Promise.resolve({ ok: false, code: 'grant_not_propagated', detail: 'no OPA instances are configured to wait for' });
  if (done()) return Promise.resolve({ ok: true, ms: 0 });
  return new Promise((resolve) => {
    const finish = (r: PropagationResult) => {
      clearTimeout(timer);
      s.waiters.delete(check);
      resolve(r);
    };
    const check: Waiter = () => {
      if (done()) finish({ ok: true, ms: Date.now() - start });
    };
    const timer = setTimeout(() => {
      const seen = instances.map((i) => `${i}=${s.instances.get(i)?.bundles[bundle]?.active_revision ?? 'no report'}`).join(', ');
      finish({ ok: false, code: 'grant_not_propagated', detail: `${bundle} revision ${wanted} not active on every OPA within ${timeoutMs} ms (${seen})` });
    }, timeoutMs);
    s.waiters.add(check);
  });
}

/** Test hook. */
export function __resetOpaStatus(): void {
  const s = st();
  s.instances.clear();
  s.waiters.clear();
}
