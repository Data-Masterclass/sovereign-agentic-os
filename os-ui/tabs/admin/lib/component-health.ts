/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Components: version, health and restarts read live, never typed in
 *             (design 00 §6; WP-05).
 * USER STORY: As an operator I want each component row to show the version the component itself
 *             reports, its own health, and the real restart count of its pods — and, when a
 *             component cannot be reached, the reason instead of a version.
 * ARCHITECTURE:
 *   - Version and health: `COMPONENT_HEALTH[id]()` (core/adapters/<component>/health.ts), the
 *     component's own endpoint. `ok:false` → `version: null` and the reason in `versionNote`.
 *   - A component with no version endpoint: the running pod's image tag (Kubernetes
 *     `status.containerStatuses[].image`), labelled `versionSource: 'image'`.
 *   - os-ui itself: its own build version (`OS_VERSION`, set by the chart).
 *   - Not running (off / disabled / n/a): no probe, `version: null` and the status as the note.
 *   - Restarts: the sum of `restartCount` of the workload's pods and the last termination reason.
 *   - Pure over injected readers, so the unit test can prove every version came from health().
 */
import { config } from '@core/kernel/config';
import { k8s } from '@core/infra/k8s';
import type { ComponentHealth, Fetched } from '@core/adapters/_contract';
import { COMPONENT_HEALTH, type HealthFn } from '@core/adapters/health';
import type { ComponentView } from './platform';

export type PodSignal = {
  pods: number;
  ready: number;
  restarts: number;
  lastReason: string | null;
  waitingReason: string | null;
  image: string | null;
};

export type Restarts = {
  restarts: number;
  state: 'healthy' | 'healing' | 'degraded' | 'unknown';
  note: string;
};

export type ComponentRow = ComponentView & {
  version: string | null;
  versionSource: 'component' | 'image' | 'none';
  versionNote: string;
  health: { status: 'ready' | 'degraded' | Extract<Fetched<ComponentHealth>, { ok: false }>['reason'] | 'not-running' | 'no-endpoint'; detail: string; checkedAt: string | null };
  selfHeal: Restarts;
};

const NOT_RUNNING = new Set(['off', 'disabled', 'stopped', 'n/a', 'on-demand']);

/** `repo/name:tag@sha256:…` → `tag`; a digest-only reference → the short digest. */
export function imageTag(image: string | null): string | null {
  if (!image) return null;
  const noDigest = image.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon > slash) return noDigest.slice(colon + 1);
  const digest = image.split('@')[1];
  return digest ? digest.slice(0, 19) : null;
}

export function restartsOf(sig: PodSignal | null): Restarts {
  if (!sig) return { restarts: 0, state: 'unknown', note: 'pods not readable' };
  if (sig.pods === 0) return { restarts: 0, state: 'unknown', note: 'no pods' };
  const last = sig.lastReason ? `; last exit: ${sig.lastReason}` : '';
  if (sig.waitingReason === 'CrashLoopBackOff') return { restarts: sig.restarts, state: 'degraded', note: `CrashLoopBackOff, ${sig.restarts} restart(s)${last}` };
  if (sig.ready < sig.pods) return { restarts: sig.restarts, state: 'healing', note: `${sig.ready}/${sig.pods} pod(s) ready${sig.waitingReason ? ` (${sig.waitingReason})` : ''}${last}` };
  return { restarts: sig.restarts, state: 'healthy', note: sig.restarts ? `${sig.restarts} restart(s)${last}` : 'no restarts' };
}

/** Live pod signal of a Deployment / StatefulSet / DaemonSet, through its own selector. */
export async function podSignal(c: ComponentView): Promise<PodSignal | null> {
  const kind = c.kind === 'deploy' ? 'deployments' : c.kind === 'sts' || c.kind === 'cluster' ? 'statefulsets' : c.kind === 'ds' ? 'daemonsets' : null;
  if (!kind || !c.workload) return null;
  const ns = c.ns || config.platformNamespace;
  const w = await k8s('GET', `/apis/apps/v1/namespaces/${ns}/${kind}/${c.workload}`);
  if (w.status !== 200) return null;
  const labels = ((w.body.spec as { selector?: { matchLabels?: Record<string, string> } })?.selector?.matchLabels) ?? {};
  const sel = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
  if (!sel) return null;
  const p = await k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(sel)}`);
  if (p.status !== 200) return null;
  type CS = { ready?: boolean; restartCount?: number; image?: string; state?: { waiting?: { reason?: string } }; lastState?: { terminated?: { reason?: string } } };
  const items = (p.body.items as { status?: { containerStatuses?: CS[] } }[] | undefined) ?? [];
  const sig: PodSignal = { pods: items.length, ready: 0, restarts: 0, lastReason: null, waitingReason: null, image: null };
  for (const pod of items) {
    const cs = pod.status?.containerStatuses ?? [];
    if (cs.length && cs.every((x) => x.ready)) sig.ready += 1;
    for (const x of cs) {
      sig.restarts += x.restartCount ?? 0;
      sig.lastReason = x.lastState?.terminated?.reason ?? sig.lastReason;
      sig.waitingReason = x.state?.waiting?.reason ?? sig.waitingReason;
    }
    sig.image = sig.image ?? cs[0]?.image ?? null;
  }
  return sig;
}

export type Readers = {
  health: Readonly<Record<string, HealthFn>>;
  pods: (c: ComponentView) => Promise<PodSignal | null>;
  osVersion: string;
};

const LIVE: Readers = { health: COMPONENT_HEALTH, pods: podSignal, osVersion: config.osVersion };

export async function componentRow(c: ComponentView, r: Readers = LIVE): Promise<ComponentRow> {
  const sig = await r.pods(c);
  const selfHeal = restartsOf(sig);
  if (c.id === 'os-ui') {
    return { ...c, version: r.osVersion, versionSource: 'component', versionNote: 'this build (OS_VERSION)', health: { status: 'ready', detail: 'serving this page', checkedAt: new Date().toISOString() }, selfHeal };
  }
  if (NOT_RUNNING.has(c.status)) {
    return { ...c, version: null, versionSource: 'none', versionNote: `not running (${c.status})`, health: { status: 'not-running', detail: c.status, checkedAt: null }, selfHeal };
  }
  const fn = r.health[c.id];
  if (!fn) {
    const tag = imageTag(sig?.image ?? null);
    return {
      ...c,
      version: tag,
      versionSource: tag ? 'image' : 'none',
      versionNote: tag ? 'image tag of the running pod (no version endpoint)' : 'no version endpoint and no running pod image',
      health: { status: 'no-endpoint', detail: 'no health endpoint; status is the workload\'s', checkedAt: null },
      selfHeal,
    };
  }
  const h = await fn();
  if (!h.ok) {
    return { ...c, version: null, versionSource: 'none', versionNote: `${h.reason}: ${h.detail}`, health: { status: h.reason, detail: h.detail, checkedAt: h.at }, selfHeal };
  }
  if (h.value.version === null) {
    const tag = imageTag(sig?.image ?? null);
    return { ...c, version: tag, versionSource: tag ? 'image' : 'none', versionNote: tag ? 'image tag of the running pod (the component reports no version)' : 'the component reports no version', health: { status: h.value.status, detail: h.value.detail ?? '', checkedAt: h.at }, selfHeal };
  }
  return { ...c, version: h.value.version, versionSource: 'component', versionNote: 'reported by the component', health: { status: h.value.status, detail: h.value.detail ?? '', checkedAt: h.at }, selfHeal };
}

export function componentRows(cs: ComponentView[], r: Readers = LIVE): Promise<ComponentRow[]> {
  return Promise.all(cs.map((c) => componentRow(c, r)));
}
