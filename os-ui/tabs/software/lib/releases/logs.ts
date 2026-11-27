/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - an app's own logs per env and preview slot, redacted, never another app's
 * USER STORY: As an app builder I want to read what my app printed in Dev, Prod or a preview, without secrets or tokens
 *             showing, and I must never be able to read another app's logs.
 * ARCHITECTURE: (spec 6.6, 13)
 *   - The platform log collector refuses the app namespaces, so app logs come from the Kubernetes `pods/log` API of the
 *     env namespace (os-ui's Role there grants exactly get on pods/log, C1), through `liveCnpgK8sText` (the adapter that
 *     accepts any content type: Kubernetes 1.36 answers 406 to text/plain-only).
 *   - SCOPED BY CONSTRUCTION: pods are listed by the EXACT label `app.kubernetes.io/name=<appResourceName(domain, slug
 *     [, slot])>` in the env namespace, and every listed pod is re-checked to carry exactly that label. No caller input
 *     reaches the selector, the namespace or the pod name (env and slot are closed enums). The deploy gate forces every
 *     app's pods to carry their own name label and nobody else's (native-deploy selector rule), so a pod with this label
 *     is this app's.
 *   - Authz (callers): the app's EDITORS only (lib/appdb/access.ts `editableApp`): logs may hold user data, so viewing
 *     an app is not enough. An app token never reaches the route (not on the app-token allowlist).
 *   - Redaction before anything leaves os-ui: OS tokens (`sos_…`), JWTs (incl. app tokens), Bearer/Basic credentials,
 *     private-key blocks, postgres URLs with a password, `password=` pairs, and the VALUE of any assignment to one of the
 *     app's own secret env NAMES (`NAME=…`, `"NAME":"…"`). os-ui cannot redact a secret value by value: it never reads
 *     the app's env Secret (D's rule), so the names are the anchor. Log content is never logged by os-ui.
 *   - Bounded: tail ≤ 1000 lines and 256 KiB per pod, at most 5 pods.
 */
import 'server-only';
import { liveCnpgK8sText, type CnpgK8sText } from '@core/adapters/cnpg/client';
import { appResourceName, type AppEnv, type PreviewSlot } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { k8s as liveK8s } from '@core/infra/k8s';
import type { RunnerK8s } from '@tabs/software/lib/runner';
import { envNamespaceOf } from '@tabs/software/lib/releases/rollout';

export const LOG_TAIL_MAX = 1000;
export const LOG_BYTES_MAX = 256 * 1024;
const POD_MAX = 5;
export const REDACTED = '[redacted]';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: the log text with every credential pattern and every value of a secret env name replaced. */
export function redactLogs(text: string, secretNames: readonly string[] = []): string {
  let out = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\bsos_[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b((?:PG)?PASSWORD|passwd|pwd|secret|api[_-]?key|token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1$2${REDACTED}`);
  for (const name of secretNames) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) continue;
    const n = escapeRe(name);
    out = out
      .replace(new RegExp(`(\\b${n}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`, 'g'), `$1${REDACTED}`)
      .replace(new RegExp(`("${n}"\\s*:\\s*)"[^"]*"`, 'g'), `$1"${REDACTED}"`);
  }
  return out;
}

export type AppLogsInput = { env: AppEnv; slot?: PreviewSlot; tail?: number };
export type AppLogsView = {
  env: AppEnv;
  slot: PreviewSlot | null;
  deployment: string;
  pods: { name: string; phase: string }[];
  /** Redacted text, newest pod first, each pod's block headed `==> <pod> <==`. */
  text: string;
  truncated: boolean;
  problem: string | null;
};

export type LogsDeps = { k8s?: RunnerK8s; k8sText?: CnpgK8sText; namespace?: (env: AppEnv) => string; secretNames?: (app: App, env: AppEnv) => Promise<string[]> };

/** The app's secret env names. An unreadable list is a refusal (no logs), never "no secrets": redaction needs them. */
async function liveSecretNames(app: App, env: AppEnv): Promise<string[]> {
  const { listAppEnv } = await import('@tabs/software/lib/appdb/env-secrets');
  return (await listAppEnv(app.domain, app.slug, env)).filter((e) => e.kind === 'secret').map((e) => e.name);
}

export async function readAppLogs(app: App, input: AppLogsInput, deps: LogsDeps = {}): Promise<AppLogsView> {
  if (input.env !== 'dev' && input.env !== 'prod') throw Object.assign(new Error('env must be "dev" or "prod"'), { status: 400 });
  if (input.slot !== undefined && input.slot !== 'p1' && input.slot !== 'p2') throw Object.assign(new Error('slot must be "p1" or "p2"'), { status: 400 });
  if (input.slot && input.env !== 'dev') throw Object.assign(new Error('preview slots exist in Dev only'), { status: 400 });
  const tail = Math.max(1, Math.min(LOG_TAIL_MAX, Math.floor(Number(input.tail ?? 200)) || 200));
  const ns = (deps.namespace ?? envNamespaceOf)(input.env);
  const deployment = appResourceName(app.domain, app.slug, input.slot);
  const k8s = deps.k8s ?? (liveK8s as RunnerK8s);
  const view: AppLogsView = { env: input.env, slot: input.slot ?? null, deployment, pods: [], text: '', truncated: false, problem: null };
  const listed = await k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${deployment}`)}`);
  if (listed.status === 0) return { ...view, problem: 'the Kubernetes API is unreachable' };
  if (listed.status !== 200) return { ...view, problem: `Kubernetes refused to list the pods (HTTP ${listed.status})` };
  type Pod = { metadata?: { name?: string; creationTimestamp?: string; labels?: Record<string, string> }; status?: { phase?: string } };
  const pods = ((listed.body.items ?? []) as Pod[])
    .filter((p) => p.metadata?.labels?.['app.kubernetes.io/name'] === deployment && typeof p.metadata?.name === 'string')
    .sort((a, b) => String(b.metadata?.creationTimestamp ?? '').localeCompare(String(a.metadata?.creationTimestamp ?? '')));
  view.truncated = pods.length > POD_MAX;
  const secretNames = await (deps.secretNames ?? liveSecretNames)(app, input.env);
  const text = deps.k8sText ?? liveCnpgK8sText;
  const blocks: string[] = [];
  for (const p of pods.slice(0, POD_MAX)) {
    const name = p.metadata!.name as string;
    view.pods.push({ name, phase: p.status?.phase ?? 'Unknown' });
    const log = await text(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(name)}/log?tailLines=${tail}&limitBytes=${LOG_BYTES_MAX}`);
    if (log.status !== 200) {
      blocks.push(`==> ${name} <==\n(no log: HTTP ${log.status})`);
      continue;
    }
    if (log.text.length >= LOG_BYTES_MAX) view.truncated = true;
    blocks.push(`==> ${name} <==\n${redactLogs(log.text, secretNames)}`);
  }
  view.text = blocks.join('\n\n');
  if (!pods.length) view.problem = 'no pod of this app runs here';
  return view;
}
