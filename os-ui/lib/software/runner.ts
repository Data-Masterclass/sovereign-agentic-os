/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../config.ts';
import { k8s as liveK8s } from '../k8s.ts';
import type { ResourceFootprint } from './model.ts';

/**
 * The in-cluster app RUNNER (Software golden path — Phase 2). Until now a deploy
 * built + committed real code but nothing SERVED it: `startPreview`/`decideDeploy`
 * flipped the state machine and honestly left `previewUrl` null (no runner). This
 * module closes that gap: given a built app that resolves to a runnable container
 * IMAGE, it provisions a REAL Kubernetes Deployment (1 replica, sane
 * requests/limits, a readiness probe), a Service, and an Ingress on the app's
 * per-app host — then reports readiness from ACTUAL pod state, not a timer.
 *
 * It deliberately mirrors `lib/agents/schedule-cron.ts`: deterministic names,
 * idempotent upserts (GET → PUT-with-resourceVersion or POST), an injectable k8s
 * client (unit-testable without a cluster), and HONEST degradation — when the API
 * server is unreachable it returns `{ live:false }` and NEVER claims the app is
 * running. Building images in-cluster is out of scope: the image ref is the app's
 * CI-published artifact (Forgejo/Harbor registry convention) or an explicit
 * prebuilt `runImage`; a missing image surfaces as `failed`, never a fake URL.
 */

export type RunnerK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** The minimal app shape the runner needs (kept decoupled from the full App). */
export type RunnerApp = {
  slug: string;
  /** The app's per-app host (App.subdomain: `<slug>.<domain>.<appsDomain>`). */
  host: string;
  /** Explicit prebuilt image ref; when unset the registry convention is used. */
  runImage?: string;
  footprint: ResourceFootprint;
};

/** The concrete runnable spec derived from an app (image + host + resources). */
export type RunnerSpec = {
  slug: string;
  image: string;
  host: string;
  cpu: string;
  memory: string;
  /** Container port the app listens on (scaffolds EXPOSE 8080). */
  port: number;
};

/** Real pod-driven phase — `deploying → running → failed`, plus stop/absent/offline. */
export type RunnerPhase = 'deploying' | 'running' | 'failed' | 'stopped' | 'absent' | 'offline';

export type RunnerAction = 'deployed' | 'stopped' | 'deleted' | 'noop';

export type RunnerOutcome = {
  /** Did the DESIRED cluster state get applied (or already hold)? */
  ok: boolean;
  /** True only when a real cluster confirmed the effect. */
  live: boolean;
  action: RunnerAction;
  detail: string;
  name: string;
  host: string;
  /** The live URL once served (`https://<host>`); null when not applied. */
  url: string | null;
  phase: RunnerPhase;
};

export type RunnerStatus = {
  phase: RunnerPhase;
  /** True only when a real cluster answered. */
  live: boolean;
  replicas: number;
  ready: number;
  detail: string;
};

export type RunnerOpts = {
  /** Injected k8s client (defaults to the live in-cluster client). */
  k8s?: RunnerK8s;
  namespace?: string;
  ingressClass?: string;
  tlsIssuer?: string;
};

const UNREACHABLE =
  'Kubernetes API unreachable — the app runner was not provisioned; no live URL is served until connectivity is restored.';

/** Deterministic, RFC1123-safe runner object name for an app (one set per app). */
export function runnerName(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `app-${s || 'app'}`.slice(0, 52).replace(/-+$/g, '');
}

/**
 * The image the runner serves. An explicit prebuilt `runImage` wins; else the
 * platform default (`SOFTWARE_RUNNER_IMAGE`, e.g. a teaching image) when set;
 * else the CI-published registry convention `<registry>/<slug>:latest`. We never
 * BUILD here — a not-yet-published image simply fails readiness, honestly.
 */
export function appImageRef(app: { slug: string; runImage?: string }): string {
  const explicit = (app.runImage ?? '').trim();
  if (explicit) return explicit;
  if (config.softwareRunnerImage) return config.softwareRunnerImage;
  return `${config.harborRegistry}/${app.slug}:latest`;
}

/** Build the concrete runnable spec from an app (image + host + footprint). */
export function runnerSpec(app: RunnerApp): RunnerSpec {
  return {
    slug: app.slug,
    image: appImageRef(app),
    host: app.host,
    cpu: app.footprint.cpu,
    memory: app.footprint.memory,
    port: 8080,
  };
}

function labels(spec: RunnerSpec): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'os-ui',
    'app.kubernetes.io/component': 'software-runner',
    'app.kubernetes.io/name': runnerName(spec.slug),
    'soa.software-app': runnerName(spec.slug).replace(/^app-/, ''),
  };
}

// ------------------------------------------------------------- Manifests -------

export function buildDeploymentManifest(spec: RunnerSpec, namespace: string): Record<string, unknown> {
  const name = runnerName(spec.slug);
  const sel = { app: name };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels: labels(spec) },
    spec: {
      replicas: 1,
      selector: { matchLabels: sel },
      template: {
        metadata: { labels: { ...labels(spec), ...sel } },
        spec: {
          containers: [
            {
              name: 'app',
              image: spec.image,
              ports: [{ containerPort: spec.port }],
              resources: {
                requests: { cpu: spec.cpu, memory: spec.memory },
                // Memory limit == request (>= request, valid); cpu capped at 1.
                limits: { cpu: '1', memory: spec.memory },
              },
              // TCP readiness is image-agnostic (an HTTP path may 404 on a
              // healthy app), so it drives the running/deploying transition
              // off the process actually LISTENING, not a fabricated timer.
              readinessProbe: {
                tcpSocket: { port: spec.port },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                failureThreshold: 6,
              },
            },
          ],
        },
      },
    },
  };
}

export function buildServiceManifest(spec: RunnerSpec, namespace: string): Record<string, unknown> {
  const name = runnerName(spec.slug);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels: labels(spec) },
    spec: {
      selector: { app: name },
      ports: [{ name: 'http', port: 80, targetPort: spec.port }],
    },
  };
}

export function buildIngressManifest(
  spec: RunnerSpec,
  namespace: string,
  opts: Required<Pick<RunnerOpts, 'ingressClass' | 'tlsIssuer'>>,
): Record<string, unknown> {
  const name = runnerName(spec.slug);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name,
      namespace,
      labels: labels(spec),
      annotations: { 'cert-manager.io/cluster-issuer': opts.tlsIssuer },
    },
    spec: {
      ingressClassName: opts.ingressClass,
      tls: [{ hosts: [spec.host], secretName: `${spec.host}-tls` }],
      rules: [
        {
          host: spec.host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name, port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  };
}

// ------------------------------------------------------------- Resolve opts ----

function resolveOpts(opts: RunnerOpts): { k8s: RunnerK8s } & Required<Pick<RunnerOpts, 'namespace' | 'ingressClass' | 'tlsIssuer'>> {
  return {
    k8s: opts.k8s ?? (liveK8s as RunnerK8s),
    namespace: opts.namespace ?? config.softwareRunnerNamespace,
    ingressClass: opts.ingressClass ?? config.appsIngressClass,
    tlsIssuer: opts.tlsIssuer ?? config.appsTlsIssuer,
  };
}

// ------------------------------------------------------------- Primitives ------

/** Ensure the runner namespace exists. Returns reachability + whether it holds. */
async function ensureNamespace(k8s: RunnerK8s, ns: string): Promise<{ reachable: boolean; ok: boolean }> {
  const got = await k8s('GET', `/api/v1/namespaces/${ns}`);
  if (got.status === 0) return { reachable: false, ok: false };
  if (got.status === 200) return { reachable: true, ok: true };
  // 401/403: the runner's namespaced ServiceAccount cannot read/create a CLUSTER-scoped
  // Namespace object — but the Helm chart PRE-CREATES the runner namespace, so its
  // existence is guaranteed. Treat "forbidden" as "it's there, managed externally" and
  // proceed to the namespaced writes (deployments/services/ingresses) the SA CAN do.
  if (got.status === 401 || got.status === 403) return { reachable: true, ok: true };
  if (got.status === 404) {
    const made = await k8s('POST', '/api/v1/namespaces', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: ns, labels: { 'app.kubernetes.io/managed-by': 'os-ui', 'soa.software-runner': 'true' } },
    });
    // A 403 on create also means the chart owns it — proceed.
    return { reachable: true, ok: made.status === 201 || made.status === 200 || made.status === 409 || made.status === 403 };
  }
  return { reachable: true, ok: false };
}

/** Idempotent create-or-replace of one object. `reachable:false` = API down. */
async function applyObject(
  k8s: RunnerK8s,
  collection: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<{ reachable: boolean; ok: boolean; status: number }> {
  const object = `${collection}/${name}`;
  const existing = await k8s('GET', object);
  if (existing.status === 0) return { reachable: false, ok: false, status: 0 };
  if (existing.status === 200) {
    const meta = (existing.body.metadata ?? {}) as Record<string, unknown>;
    (manifest.metadata as Record<string, unknown>).resourceVersion = meta.resourceVersion;
    const put = await k8s('PUT', object, manifest);
    return { reachable: true, ok: put.status === 200 || put.status === 201, status: put.status };
  }
  if (existing.status === 404) {
    const post = await k8s('POST', collection, manifest);
    return { reachable: true, ok: post.status === 201 || post.status === 200, status: post.status };
  }
  return { reachable: true, ok: false, status: existing.status };
}

function collections(ns: string) {
  return {
    deployments: `/apis/apps/v1/namespaces/${ns}/deployments`,
    services: `/api/v1/namespaces/${ns}/services`,
    ingresses: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
  };
}

// ------------------------------------------------------------- Deploy ----------

/**
 * Provision (or reconcile) the app's Deployment + Service + Ingress. Idempotent:
 * a re-deploy REPLACES the existing objects rather than duplicating them. Never
 * throws; returns an honest outcome. On success the caller surfaces `url`; the
 * `phase` reflects real pod readiness read straight back from the API.
 */
export async function deployApp(app: RunnerApp, options: RunnerOpts = {}): Promise<RunnerOutcome> {
  const o = resolveOpts(options);
  const spec = runnerSpec(app);
  const name = runnerName(spec.slug);
  const url = `https://${spec.host}`;
  const c = collections(o.namespace);

  const nsRes = await ensureNamespace(o.k8s, o.namespace);
  if (!nsRes.reachable) return { ok: false, live: false, action: 'noop', name, host: spec.host, url: null, phase: 'offline', detail: UNREACHABLE };
  if (!nsRes.ok) return { ok: false, live: true, action: 'noop', name, host: spec.host, url: null, phase: 'failed', detail: `Could not ensure runner namespace ${o.namespace}.` };

  const dep = await applyObject(o.k8s, c.deployments, name, buildDeploymentManifest(spec, o.namespace));
  if (!dep.reachable) return { ok: false, live: false, action: 'noop', name, host: spec.host, url: null, phase: 'offline', detail: UNREACHABLE };
  const svc = await applyObject(o.k8s, c.services, name, buildServiceManifest(spec, o.namespace));
  const ing = await applyObject(o.k8s, c.ingresses, name, buildIngressManifest(spec, o.namespace, o));

  if (!dep.ok || !svc.ok || !ing.ok) {
    return {
      ok: false,
      live: true,
      action: 'noop',
      name,
      host: spec.host,
      url: null,
      phase: 'failed',
      detail: `Kubernetes rejected part of the deploy (deployment ${dep.status}, service ${svc.status}, ingress ${ing.status}).`,
    };
  }

  const st = await statusOfName(o.k8s, o.namespace, name);
  return {
    ok: true,
    live: true,
    action: 'deployed',
    name,
    host: spec.host,
    url,
    phase: st.phase === 'offline' || st.phase === 'absent' ? 'deploying' : st.phase,
    detail: `Provisioned Deployment+Service+Ingress for ${spec.slug} on ${spec.host} (image ${spec.image}).`,
  };
}

// ------------------------------------------------------------- Status ----------

function mapDeploymentStatus(body: Record<string, unknown>): RunnerStatus {
  const spec = (body.spec ?? {}) as Record<string, unknown>;
  const status = (body.status ?? {}) as Record<string, unknown>;
  const replicas = Number(spec.replicas ?? 0) || 0;
  const ready = Number(status.readyReplicas ?? 0) || 0;
  if (replicas === 0) {
    return { phase: 'stopped', live: true, replicas, ready, detail: 'Scaled to zero (stopped).' };
  }
  if (ready >= 1) {
    return { phase: 'running', live: true, replicas, ready, detail: `Running (${ready}/${replicas} ready).` };
  }
  // Not ready yet — distinguish a progress-deadline failure from still rolling out.
  const conditions = (status.conditions ?? []) as { type?: string; reason?: string; status?: string }[];
  const stalled = conditions.some(
    (cond) => cond.type === 'Progressing' && cond.reason === 'ProgressDeadlineExceeded',
  );
  const unavailable = conditions.some(
    (cond) => cond.type === 'Available' && cond.status === 'False' && cond.reason === 'MinimumReplicasUnavailable',
  );
  if (stalled) {
    return { phase: 'failed', live: true, replicas, ready, detail: 'Rollout failed (progress deadline exceeded) — check the image ref and pod events.' };
  }
  return { phase: 'deploying', live: true, replicas, ready, detail: `Deploying (${ready}/${replicas} ready)${unavailable ? ' — pulling image / starting' : ''}.` };
}

async function statusOfName(k8s: RunnerK8s, ns: string, name: string): Promise<RunnerStatus> {
  const got = await k8s('GET', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
  if (got.status === 0) return { phase: 'offline', live: false, replicas: 0, ready: 0, detail: UNREACHABLE };
  if (got.status === 404) return { phase: 'absent', live: true, replicas: 0, ready: 0, detail: 'No runner deployed for this app.' };
  if (got.status !== 200) return { phase: 'offline', live: false, replicas: 0, ready: 0, detail: `Kubernetes API error reading the deployment (HTTP ${got.status}).` };
  return mapDeploymentStatus(got.body);
}

/** Read the app's REAL runner status (pod-driven), for the lifecycle transition. */
export async function runnerStatus(app: { slug: string }, options: RunnerOpts = {}): Promise<RunnerStatus> {
  const o = resolveOpts(options);
  return statusOfName(o.k8s, o.namespace, runnerName(app.slug));
}

// ------------------------------------------------------------- Stop / delete ---

/** Stop the app: scale the Deployment to zero (retains the objects for restart). */
export async function stopApp(app: { slug: string }, options: RunnerOpts = {}): Promise<RunnerOutcome> {
  const o = resolveOpts(options);
  const name = runnerName(app.slug);
  const path = `/apis/apps/v1/namespaces/${o.namespace}/deployments/${name}/scale`;
  const res = await o.k8s('PATCH', path, { spec: { replicas: 0 } });
  if (res.status === 0) return { ok: false, live: false, action: 'noop', name, host: '', url: null, phase: 'offline', detail: UNREACHABLE };
  if (res.status === 404) return { ok: true, live: true, action: 'noop', name, host: '', url: null, phase: 'absent', detail: 'No runner to stop.' };
  if (res.status === 200 || res.status === 201) return { ok: true, live: true, action: 'stopped', name, host: '', url: null, phase: 'stopped', detail: `Scaled ${name} to zero (stopped).` };
  return { ok: false, live: true, action: 'noop', name, host: '', url: null, phase: 'failed', detail: `Kubernetes rejected the scale-to-zero (HTTP ${res.status}).` };
}

/** Delete the app runner entirely: Ingress + Service + Deployment (404 = benign). */
export async function deleteApp(app: { slug: string }, options: RunnerOpts = {}): Promise<RunnerOutcome> {
  const o = resolveOpts(options);
  const name = runnerName(app.slug);
  const c = collections(o.namespace);
  const targets = [`${c.ingresses}/${name}`, `${c.services}/${name}`, `${c.deployments}/${name}`];
  let reachable = true;
  let rejected = 0;
  for (const t of targets) {
    const res = await o.k8s('DELETE', t);
    if (res.status === 0) reachable = false;
    else if (!(res.status === 200 || res.status === 202 || res.status === 404)) rejected += 1;
  }
  if (!reachable) return { ok: false, live: false, action: 'noop', name, host: '', url: null, phase: 'offline', detail: UNREACHABLE };
  if (rejected > 0) return { ok: false, live: true, action: 'noop', name, host: '', url: null, phase: 'failed', detail: `Kubernetes rejected ${rejected} of the runner deletes.` };
  return { ok: true, live: true, action: 'deleted', name, host: '', url: null, phase: 'absent', detail: `Deleted runner Deployment+Service+Ingress for ${app.slug}.` };
}
