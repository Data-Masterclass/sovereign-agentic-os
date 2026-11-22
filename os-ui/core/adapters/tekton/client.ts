/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Tekton adapter: the one door through which the OS reaches Tekton and its Kubernetes objects.
 * USER STORY: As an operator I want a Tekton that is down or refusing to show up as exactly that, with its
 *             reason, and every call to it to pass one reviewed module.
 * ARCHITECTURE:
 *   - Tekton's documented interfaces only: the Triggers EventListener (HTTP POST of a JSON event,
 *     https://tekton.dev/docs/triggers/eventlisteners/), PipelineRun/TaskRun objects through the Kubernetes API
 *     (https://tekton.dev/docs/pipelines/pipelineruns/) and the step logs through the pod log subresource.
 *   - Returns plain status/body pairs; `status: 0` means "could not reach it". The callers
 *     (`tabs/software/lib/tekton-checks.ts`) turn that into a named failure; nothing is retried or defaulted here.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';
import { k8s as liveK8s, k8sText as liveK8sText } from '@core/infra/k8s';

export type TektonObj = Record<string, unknown>;
export type TektonK8s = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: TektonObj }>;
export type TektonK8sText = (path: string) => Promise<{ status: number; text: string }>;
export type TektonPost = (url: string, json: unknown) => Promise<{ status: number; text: string }>;
export type EventReply = { status: number; text: string };

/** Where the engine lives for this OS: the build namespace and the EventListener URL (both empty = Tekton is off). */
export const tektonNamespace = (): string => config.softwareTektonNamespace;
export const tektonListenerUrl = (): string => config.softwareTektonListenerUrl;
export const tektonWaitMs = (): number => config.softwareTektonWaitMs;

export const liveTektonK8s: TektonK8s = liveK8s as TektonK8s;
export const liveTektonK8sText: TektonK8sText = liveK8sText as TektonK8sText;

/** POST one event to the EventListener: the listener's own HTTP answer, or `unreachable`/`timeout` with the reason. */
export async function postEvent(url: string, json: unknown): Promise<Fetched<EventReply>> {
  const at = new Date().toISOString();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json), signal: AbortSignal.timeout(10_000) });
    return { ok: true, value: { status: res.status, text: await res.text() }, at };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'unreachable', detail: e instanceof Error ? e.message : String(e), at };
  }
}

const runsPath = (ns: string) => `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`;
const selector = (labels: Record<string, string>) => `labelSelector=${encodeURIComponent(Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(','))}`;

export const listRuns = (k8s: TektonK8s, ns: string, labels: Record<string, string>) => k8s('GET', `${runsPath(ns)}?${selector(labels)}`);
export const getRun = (k8s: TektonK8s, ns: string, name: string) => k8s('GET', `${runsPath(ns)}/${name}`);
/** Tekton's own cancellation (`spec.status: Cancelled`); a run is never deleted to stop it. */
export const cancelRun = (k8s: TektonK8s, ns: string, name: string) => k8s('PATCH', `${runsPath(ns)}/${name}`, { spec: { status: 'Cancelled' } });
export const listTaskRuns = (k8s: TektonK8s, ns: string, pipelineRun: string) =>
  k8s('GET', `/apis/tekton.dev/v1/namespaces/${ns}/taskruns?${selector({ 'tekton.dev/pipelineRun': pipelineRun })}`);
export const stepLog = (k8sText: TektonK8sText, ns: string, pod: string, container: string, limitBytes: number) =>
  k8sText(`/api/v1/namespaces/${ns}/pods/${pod}/log?container=${container}&limitBytes=${limitBytes}`);
