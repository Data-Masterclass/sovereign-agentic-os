/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '@core/kernel/config';
import { k8s as liveK8s } from '@core/infra/k8s';
import { planAppDeploy, runnerName, APP_K8S_DIR } from '@tabs/software/lib/native-deploy';

export { runnerName };

/**
 * The in-cluster app RUNNER for `serveMode: 'image'` apps (WP-54).
 *
 * WHAT RUNS IS WHAT IS IN GIT. The runner deploys the app's COMMITTED Kubernetes manifests
 * (`apps/<slug>/k8s/*.yaml`, read from the domain repository) and nothing else: no object is
 * built here. `native-deploy.ts` checks the OS's own rules (kinds, names, the platform registry,
 * digest only); then every object is submitted to the Kubernetes API as a server-side DRY RUN
 * (`?dryRun=All`), so the API server's schema validation and the namespace's Pod Security
 * `restricted` admission judge the files before anything is written; only then is each object
 * applied for real (GET → PUT with resourceVersion, or POST). The only change made to a committed
 * object is `metadata.namespace`, exactly what `kubectl apply -n <ns> -f k8s/` does.
 *
 * Honest by construction: no manifests, an unbuilt image, a foreign registry or a git read failure
 * is a typed refusal with ZERO Kubernetes calls; an unreachable API server is `offline`, never a
 * live claim; readiness comes from the Deployment's real status. The OS builds no images.
 */

export type RunnerK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** What git said about the app's tree (see `readAppTreeState`). */
export type RunnerTree =
  | { kind: 'tree'; files: { path: string; content: string }[]; sha: string }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

/** The minimal app shape the runner needs: its name, its host and its committed tree. */
export type RunnerApp = {
  slug: string;
  /** The app's per-app host (`<slug>.<domain>.<appsDomain>`). */
  host: string;
  /** The app subtree (`apps/<slug>/`, paths relative to it) as read from git. */
  tree: RunnerTree;
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
  /** The platform image registry prefix (defaults to `softwareRunner.imageRegistry`). */
  registry?: string;
  /** The ingress class / cert-manager issuer an app's Ingress must match (default: the chart's). */
  ingressClass?: string;
  tlsIssuer?: string;
};

const UNREACHABLE =
  'Kubernetes API unreachable — the app runner was not provisioned; no live URL is served until connectivity is restored.';

function resolveOpts(opts: RunnerOpts): { k8s: RunnerK8s; namespace: string; registry: string; ingressClass: string; tlsIssuer: string } {
  return {
    ingressClass: opts.ingressClass ?? config.appsIngressClass,
    tlsIssuer: opts.tlsIssuer ?? config.appsTlsIssuer,
    k8s: opts.k8s ?? (liveK8s as RunnerK8s),
    namespace: opts.namespace ?? config.softwareRunnerNamespace,
    registry: opts.registry ?? config.softwareImageRegistry,
  };
}

// ------------------------------------------------------------- Primitives ------

/** Ensure the runner namespace exists. Returns reachability + whether it holds. */
async function ensureNamespace(k8s: RunnerK8s, ns: string): Promise<{ reachable: boolean; ok: boolean }> {
  const got = await k8s('GET', `/api/v1/namespaces/${ns}`);
  if (got.status === 0) return { reachable: false, ok: false };
  // 200: present. 401/403: the os-ui ServiceAccount cannot read a cluster-scoped Namespace, but
  // the chart pre-creates the runner namespace (with its Pod Security labels), so it is there.
  if (got.status === 200 || got.status === 401 || got.status === 403) return { reachable: true, ok: true };
  // The runner never creates the namespace: it would be created WITHOUT the chart's Pod Security
  // `restricted` labels and NetworkPolicies.
  return { reachable: true, ok: false };
}

const COLLECTION: Record<string, (ns: string) => string> = {
  Deployment: (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`,
  Service: (ns) => `/api/v1/namespaces/${ns}/services`,
  Ingress: (ns) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
};

type Applied = { reachable: boolean; ok: boolean; status: number; message: string };

/** Create-or-replace one object; `dryRun` submits it with `?dryRun=All` (nothing persisted). */
async function applyObject(k8s: RunnerK8s, collection: string, manifest: Record<string, unknown>, dryRun: boolean): Promise<Applied> {
  const meta = manifest.metadata as Record<string, unknown>;
  const object = `${collection}/${String(meta.name)}`;
  const q = dryRun ? '?dryRun=All' : '';
  const msg = (b: Record<string, unknown>) => String(b.message ?? '');
  const existing = await k8s('GET', object);
  if (existing.status === 0) return { reachable: false, ok: false, status: 0, message: '' };
  if (existing.status === 200) {
    const rv = ((existing.body.metadata ?? {}) as Record<string, unknown>).resourceVersion;
    const body = { ...manifest, metadata: { ...meta, ...(rv !== undefined ? { resourceVersion: rv } : {}) } };
    const put = await k8s('PUT', `${object}${q}`, body);
    return { reachable: put.status !== 0, ok: put.status === 200 || put.status === 201, status: put.status, message: msg(put.body) };
  }
  if (existing.status === 404) {
    const post = await k8s('POST', `${collection}${q}`, manifest);
    return { reachable: post.status !== 0, ok: post.status === 201 || post.status === 200, status: post.status, message: msg(post.body) };
  }
  return { reachable: true, ok: false, status: existing.status, message: msg(existing.body) };
}

// ------------------------------------------------------------- Deploy ----------

/**
 * Deploy (or re-deploy) the app's committed `k8s/` manifests. Idempotent; never throws; returns
 * an honest outcome. On success the caller surfaces `url`; `phase` is real pod readiness.
 */
export async function deployApp(app: RunnerApp, options: RunnerOpts = {}): Promise<RunnerOutcome> {
  const o = resolveOpts(options);
  const name = runnerName(app.slug);
  const refuse = (detail: string, phase: RunnerPhase = 'failed', live = false): RunnerOutcome => ({
    ok: false, live, action: 'noop', name, host: app.host, url: null, phase, detail,
  });

  if (app.tree.kind === 'failed') {
    return refuse(`The app's deploy manifests are read from git, and git could not be read (${app.tree.reason}). Nothing was deployed.`);
  }
  const files = app.tree.kind === 'tree' ? app.tree.files : [];
  const sha = app.tree.kind === 'tree' ? app.tree.sha : '';
  const plan = planAppDeploy(files, {
    slug: app.slug,
    host: app.host,
    registry: o.registry,
    ingressClass: o.ingressClass,
    tlsIssuer: o.tlsIssuer,
  });
  if (!plan.ok) return refuse(plan.reason);

  const objects: Record<string, unknown>[] = plan.objects.map((obj) => ({
    ...obj,
    metadata: { ...(obj.metadata as Record<string, unknown>), namespace: o.namespace },
  }));

  const nsRes = await ensureNamespace(o.k8s, o.namespace);
  if (!nsRes.reachable) return refuse(UNREACHABLE, 'offline');
  if (!nsRes.ok) return refuse(`The runner namespace ${o.namespace} does not exist; it is created by the chart, not by a deploy.`, 'failed', true);

  // 1. Server-side DRY RUN of every object: Kubernetes' schema validation decides. Pod Security
  //    admission judges PODS, not Deployments (a Deployment that violates `restricted` is accepted
  //    and its pods are then refused), so the Deployment's own pod template is also submitted as a
  //    dry-run Pod: the namespace's real admission answers before anything is written.
  const rejected = (what: string, r: Applied) =>
    refuse(
      `Kubernetes rejected ${APP_K8S_DIR}/ ${what} '${name}' in a dry run (HTTP ${r.status})${r.message ? `: ${r.message}` : ''}. Nothing was applied.`,
      'failed',
      true,
    );
  for (const obj of objects) {
    const r = await applyObject(o.k8s, COLLECTION[String(obj.kind)](o.namespace), obj, true);
    if (!r.reachable) return refuse(UNREACHABLE, 'offline');
    if (!r.ok) return rejected(String(obj.kind), r);
    if (obj.kind === 'Deployment') {
      const template = ((obj.spec ?? {}) as Record<string, unknown>).template as Record<string, unknown> | undefined;
      const pod = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: `${name}-admission`, namespace: o.namespace, labels: ((template?.metadata ?? {}) as Record<string, unknown>).labels ?? {} },
        spec: template?.spec ?? {},
      };
      const p = await o.k8s('POST', `/api/v1/namespaces/${o.namespace}/pods?dryRun=All`, pod);
      if (p.status === 0) return refuse(UNREACHABLE, 'offline');
      if (p.status !== 201 && p.status !== 200) {
        return rejected('Deployment pod template', { reachable: true, ok: false, status: p.status, message: String(p.body.message ?? '') });
      }
    }
  }
  // 2. The real apply, same objects.
  const failed: string[] = [];
  for (const obj of objects) {
    const r = await applyObject(o.k8s, COLLECTION[String(obj.kind)](o.namespace), obj, false);
    if (!r.reachable) return refuse(UNREACHABLE, 'offline');
    if (!r.ok) failed.push(`${String(obj.kind)} ${r.status}${r.message ? ` (${r.message})` : ''}`);
  }
  if (failed.length) return refuse(`Kubernetes rejected part of the deploy (${failed.join(', ')}).`, 'failed', true);

  const st = await statusOfName(o.k8s, o.namespace, name);
  return {
    ok: true,
    live: true,
    action: 'deployed',
    name,
    host: app.host,
    url: `https://${app.host}`,
    phase: st.phase === 'offline' || st.phase === 'absent' ? 'deploying' : st.phase,
    detail: `Applied the committed ${APP_K8S_DIR}/ manifests of ${app.slug} at git ${sha.slice(0, 12)} (image ${plan.image}).`,
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
  const targets = ['Ingress', 'Service', 'Deployment'].map((k) => `${COLLECTION[k](o.namespace)}/${name}`);
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
