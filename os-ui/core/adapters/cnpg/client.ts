/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The CloudNativePG adapter (App Builder, workstream D): the one door through which the OS reaches the
 *             per-env app database cluster (`apps-pg`) and the Kubernetes objects an app database needs.
 * USER STORY: As a builder I want my app's own Postgres database and role created for me, isolated from every other
 *             app, without the OS ever holding a superuser password; as an operator I want a cluster that is missing
 *             or refusing to show up as exactly that, with its reason.
 * ARCHITECTURE:
 *   - CloudNativePG's documented declarative interfaces only (https://cloudnative-pg.io/documentation/current/):
 *     a managed role is an entry of `Cluster.spec.managed.roles` with a `passwordSecret` (declarative role
 *     management), a database is a `Database` resource owned by that role (declarative database management). The
 *     operator's instance manager applies both INSIDE the instance over the local socket, so os-ui never connects
 *     to Postgres and never holds a superuser credential (`enableSuperuserAccess: false` in the chart's Cluster).
 *   - The managed-role list is a list: a JSON merge patch replaces it whole. So `ensureManagedRole` reads the
 *     Cluster, edits the list and writes it back WITH the read `resourceVersion` (optimistic concurrency: a 409
 *     means another app changed it meanwhile; re-read and retry, bounded). Other roles are never touched.
 *   - Plain Kubernetes objects an app database needs (its basic-auth Secret, its one-shot Jobs, the Job's pod log)
 *     go through here too, so the Software tab never builds an API path itself.
 *   - Kubernetes is injected (`CnpgK8s`); tests use a recorded fake and a real kind cluster. Nothing is retried
 *     beyond the bounded 409 loop, nothing is defaulted: callers get a value or a typed failure (`Fetched`).
 */
import type { Adapter, ComponentHealth, Fetched } from '@core/adapters/_contract';
import { config } from '@core/kernel/config';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { k8s as liveK8s } from '@core/infra/k8s';

export type CnpgObj = Record<string, unknown>;
export type CnpgK8s = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: CnpgObj }>;
export type CnpgK8sText = (path: string) => Promise<{ status: number; text: string }>;
export const liveCnpgK8s: CnpgK8s = liveK8s as CnpgK8s;
/**
 * GET a plain-text subresource (a pod's log) with the pod's ServiceAccount, like `core/infra/k8s.ts k8sText` but
 * accepting any content type: Kubernetes 1.36 answers 406 to a log request that accepts ONLY `text/plain` (kind
 * v1.36.1, 2026-11-27), which `k8sText` sends. Never throws: no credential or no answer is `{ status: 0 }`.
 */
export const liveCnpgK8sText: CnpgK8sText = (path) =>
  new Promise((resolve) => {
    const dir = process.env.OS_K8S_SA_DIR ?? '/var/run/secrets/kubernetes.io/serviceaccount';
    let token: string;
    let ca: Buffer;
    try {
      token = readFileSync(`${dir}/token`, 'utf8').trim();
      ca = readFileSync(`${dir}/ca.crt`);
    } catch {
      resolve({ status: 0, text: '' });
      return;
    }
    const url = new URL((process.env.KUBERNETES_API ?? 'https://kubernetes.default.svc') + path);
    const req = https.request(
      { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'text/plain, */*' }, ca, timeout: 10_000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: buf }));
      },
    );
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, text: '' });
    });
    req.end();
  });

const API = '/apis/postgresql.cnpg.io/v1';
const clusterPath = (ns: string, name: string) => `${API}/namespaces/${ns}/clusters/${name}`;
const databasesPath = (ns: string) => `${API}/namespaces/${ns}/databases`;
const secretsPath = (ns: string) => `/api/v1/namespaces/${ns}/secrets`;
const jobsPath = (ns: string) => `/apis/batch/v1/namespaces/${ns}/jobs`;

const now = () => new Date().toISOString();

/** A CNPG managed role (`Cluster.spec.managed.roles[]`, RoleConfiguration). Only the fields the OS sets. */
export type ManagedRole = {
  name: string;
  ensure: 'present' | 'absent';
  comment: string;
  login: boolean;
  superuser: false;
  createdb: false;
  createrole: false;
  replication: false;
  bypassrls: false;
  inherit: boolean;
  connectionLimit: number;
  passwordSecret: { name: string };
};

/** An app's login role: LOGIN, nothing else; the password lives only in `secretName` (the app's basic-auth Secret). */
export function appRoleSpec(name: string, secretName: string, connectionLimit = 20): ManagedRole {
  return {
    name,
    ensure: 'present',
    comment: 'App Builder app role (os-ui); owns only its own database',
    login: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    inherit: true,
    connectionLimit,
    passwordSecret: { name: secretName },
  };
}

/** The `Database` resource: database `dbName` owned by role `owner` on `cluster`. `retain`: deleting the resource never drops data. */
export function databaseManifest(ns: string, resourceName: string, cluster: string, dbName: string, owner: string, labels: Record<string, string> = {}): CnpgObj {
  return {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Database',
    metadata: { name: resourceName, namespace: ns, labels: { 'app.kubernetes.io/managed-by': 'os-ui', ...labels } },
    spec: { name: dbName, owner, cluster: { name: cluster }, ensure: 'present', databaseReclaimPolicy: 'retain' },
  };
}

export type ClusterInfo = { name: string; namespace: string; imageName: string; phase: string; readyInstances: number; instances: number };

/** The Cluster the app databases live in: its image (the REVOKE Job runs psql from it) and its phase. */
export async function readCluster(k8s: CnpgK8s, ns: string, name: string): Promise<Fetched<ClusterInfo>> {
  const at = now();
  const r = await k8s('GET', clusterPath(ns, name));
  if (r.status !== 200) return failure(r.status, `reading Cluster ${ns}/${name}`, at);
  const spec = (r.body.spec ?? {}) as CnpgObj;
  const status = (r.body.status ?? {}) as CnpgObj;
  return {
    ok: true,
    at,
    value: {
      name,
      namespace: ns,
      imageName: typeof spec.imageName === 'string' ? spec.imageName : typeof status.image === 'string' ? status.image : '',
      phase: typeof status.phase === 'string' ? status.phase : '',
      readyInstances: typeof status.readyInstances === 'number' ? status.readyInstances : 0,
      instances: typeof spec.instances === 'number' ? spec.instances : 0,
    },
  };
}

const sameRole = (a: CnpgObj, b: ManagedRole) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Make sure `role` is in the Cluster's managed roles, exactly as given (replaced when it differs). Returns whether the
 * Cluster was changed. Optimistic concurrency on `resourceVersion`; at most `attempts` read-modify-write rounds.
 */
export async function ensureManagedRole(k8s: CnpgK8s, ns: string, cluster: string, role: ManagedRole, attempts = 4): Promise<Fetched<{ changed: boolean }>> {
  const at = now();
  for (let i = 0; i < attempts; i++) {
    const got = await k8s('GET', clusterPath(ns, cluster));
    if (got.status !== 200) return failure(got.status, `reading Cluster ${ns}/${cluster}`, at);
    const meta = (got.body.metadata ?? {}) as CnpgObj;
    const managed = (((got.body.spec ?? {}) as CnpgObj).managed ?? {}) as CnpgObj;
    const roles = (Array.isArray(managed.roles) ? managed.roles : []) as CnpgObj[];
    const idx = roles.findIndex((r) => r.name === role.name);
    if (idx >= 0 && sameRole(roles[idx], role)) return { ok: true, value: { changed: false }, at };
    const next = idx >= 0 ? roles.map((r, j) => (j === idx ? role : r)) : [...roles, role];
    const patched = await k8s('PATCH', clusterPath(ns, cluster), { metadata: { resourceVersion: meta.resourceVersion }, spec: { managed: { roles: next } } });
    if (patched.status === 200) return { ok: true, value: { changed: true }, at };
    if (patched.status !== 409) return failure(patched.status, `adding role ${role.name} to Cluster ${ns}/${cluster}`, at);
  }
  return { ok: false, reason: 'conflict', detail: `Cluster ${ns}/${cluster} kept changing while role ${role.name} was added; try again`, at };
}

/** Is `name` a managed role of the Cluster, and has the instance manager applied it (`status.managedRolesStatus`)? */
export async function roleState(k8s: CnpgK8s, ns: string, cluster: string, name: string): Promise<Fetched<'reconciled' | 'pending' | 'missing'>> {
  const at = now();
  const got = await k8s('GET', clusterPath(ns, cluster));
  if (got.status !== 200) return failure(got.status, `reading Cluster ${ns}/${cluster}`, at);
  const roles = ((((got.body.spec ?? {}) as CnpgObj).managed ?? {}) as CnpgObj).roles;
  if (!Array.isArray(roles) || !roles.some((r) => (r as CnpgObj).name === name)) return { ok: true, value: 'missing', at };
  const byStatus = ((((got.body.status ?? {}) as CnpgObj).managedRolesStatus ?? {}) as CnpgObj).byStatus as Record<string, unknown> | undefined;
  const reconciled = Array.isArray(byStatus?.reconciled) && (byStatus!.reconciled as unknown[]).includes(name);
  return { ok: true, value: reconciled ? 'reconciled' : 'pending', at };
}

/** Create the `Database` resource; an existing one counts only when it is the same database with the same owner. */
export async function ensureDatabase(k8s: CnpgK8s, manifest: CnpgObj): Promise<Fetched<{ created: boolean }>> {
  const at = now();
  const meta = manifest.metadata as { name: string; namespace: string };
  const spec = manifest.spec as { name: string; owner: string; cluster: { name: string } };
  const made = await k8s('POST', databasesPath(meta.namespace), manifest);
  if (made.status === 201 || made.status === 200) return { ok: true, value: { created: true }, at };
  if (made.status !== 409) return failure(made.status, `creating Database ${meta.namespace}/${meta.name}`, at);
  const got = await k8s('GET', `${databasesPath(meta.namespace)}/${meta.name}`);
  if (got.status !== 200) return failure(got.status, `reading Database ${meta.namespace}/${meta.name}`, at);
  const have = (got.body.spec ?? {}) as { name?: string; owner?: string; cluster?: { name?: string } };
  if (have.name !== spec.name || have.owner !== spec.owner || have.cluster?.name !== spec.cluster.name) {
    return { ok: false, reason: 'conflict', detail: `Database ${meta.namespace}/${meta.name} exists for another database or owner`, at };
  }
  return { ok: true, value: { created: false }, at };
}

/** The operator's verdict on a `Database` resource (`status.applied`, `status.message`). */
export async function databaseState(k8s: CnpgK8s, ns: string, resourceName: string): Promise<Fetched<{ applied: boolean | null; message: string }>> {
  const at = now();
  const got = await k8s('GET', `${databasesPath(ns)}/${resourceName}`);
  if (got.status !== 200) return failure(got.status, `reading Database ${ns}/${resourceName}`, at);
  const status = (got.body.status ?? {}) as { applied?: boolean; message?: string };
  return { ok: true, value: { applied: typeof status.applied === 'boolean' ? status.applied : null, message: status.message ?? '' }, at };
}

/** Does the Secret exist? (never returns its data) */
export async function secretExists(k8s: CnpgK8s, ns: string, name: string): Promise<Fetched<boolean>> {
  const at = now();
  const got = await k8s('GET', `${secretsPath(ns)}/${name}`);
  if (got.status === 200) return { ok: true, value: true, at };
  if (got.status === 404) return { ok: true, value: false, at };
  return failure(got.status, `reading Secret ${ns}/${name}`, at);
}

/** The annotations that say which app a Secret belongs to; an existing Secret must carry the same ones. */
const OWNER_ANNOTATIONS = ['soa.dev/domain', 'soa.dev/slug'] as const;

/**
 * Create a Secret once. An existing one (409) is left exactly as it is, but ONLY when it belongs to the same app (the
 * `soa.dev/domain` / `soa.dev/slug` annotations of `manifest` match): a Secret of that name made by anyone else is a
 * conflict, never adopted.
 */
export async function createSecretOnce(k8s: CnpgK8s, manifest: CnpgObj): Promise<Fetched<{ created: boolean }>> {
  const at = now();
  const meta = manifest.metadata as { name: string; namespace: string; annotations?: Record<string, string> };
  const made = await k8s('POST', secretsPath(meta.namespace), manifest);
  if (made.status === 201 || made.status === 200) return { ok: true, value: { created: true }, at };
  if (made.status !== 409) return failure(made.status, `creating Secret ${meta.namespace}/${meta.name}`, at);
  const got = await k8s('GET', `${secretsPath(meta.namespace)}/${meta.name}`);
  if (got.status !== 200) return failure(got.status, `reading Secret ${meta.namespace}/${meta.name}`, at);
  const have = (((got.body.metadata ?? {}) as CnpgObj).annotations ?? {}) as Record<string, string>;
  const want = meta.annotations ?? {};
  const foreign = OWNER_ANNOTATIONS.filter((k) => k in want && have[k] !== want[k]);
  if (foreign.length) return { ok: false, reason: 'conflict', detail: `Secret ${meta.namespace}/${meta.name} exists but does not belong to this app (${foreign.join(', ')} differ); it is not taken over`, at };
  return { ok: true, value: { created: false }, at };
}

/** A Secret's METADATA only (annotations, labels, resourceVersion). Its data is read by the API call but never returned. */
export async function secretMeta(k8s: CnpgK8s, ns: string, name: string): Promise<Fetched<{ resourceVersion: string; annotations: Record<string, string>; keys: string[] } | null>> {
  const at = now();
  const got = await k8s('GET', `${secretsPath(ns)}/${name}`);
  if (got.status === 404) return { ok: true, value: null, at };
  if (got.status !== 200) return failure(got.status, `reading Secret ${ns}/${name}`, at);
  const meta = (got.body.metadata ?? {}) as { resourceVersion?: string; annotations?: Record<string, string> };
  return { ok: true, value: { resourceVersion: meta.resourceVersion ?? '', annotations: meta.annotations ?? {}, keys: Object.keys((got.body.data ?? {}) as CnpgObj).sort() }, at };
}

/** JSON merge patch of a Secret, guarded by `resourceVersion` (409 = changed meanwhile). Returns the new resourceVersion. */
export async function patchSecret(k8s: CnpgK8s, ns: string, name: string, patch: CnpgObj): Promise<Fetched<string>> {
  const at = now();
  const r = await k8s('PATCH', `${secretsPath(ns)}/${name}`, patch);
  if (r.status !== 200) return failure(r.status, `updating Secret ${ns}/${name}`, at);
  return { ok: true, value: String(((r.body.metadata ?? {}) as CnpgObj).resourceVersion ?? ''), at };
}

export type JobState = { phase: 'running' | 'succeeded' | 'failed' | 'missing'; reason: string; startedAt: string | null; finishedAt: string | null };

/** The Job's state from its own conditions (Complete / Failed), or `missing`. */
export async function jobState(k8s: CnpgK8s, ns: string, name: string): Promise<Fetched<JobState>> {
  const at = now();
  const got = await k8s('GET', `${jobsPath(ns)}/${name}`);
  if (got.status === 404) return { ok: true, value: { phase: 'missing', reason: '', startedAt: null, finishedAt: null }, at };
  if (got.status !== 200) return failure(got.status, `reading Job ${ns}/${name}`, at);
  const status = (got.body.status ?? {}) as { conditions?: { type: string; status: string; reason?: string; message?: string }[]; startTime?: string; completionTime?: string };
  const cond = (t: string) => (status.conditions ?? []).find((c) => c.type === t && c.status === 'True');
  const failed = cond('Failed');
  const done = cond('Complete');
  return {
    ok: true,
    at,
    value: {
      phase: done ? 'succeeded' : failed ? 'failed' : 'running',
      reason: failed ? [failed.reason, failed.message].filter(Boolean).join(': ') : '',
      startedAt: status.startTime ?? null,
      finishedAt: status.completionTime ?? (failed ? at : null),
    },
  };
}

export async function createJob(k8s: CnpgK8s, manifest: CnpgObj): Promise<Fetched<string>> {
  const at = now();
  const meta = manifest.metadata as { name: string; namespace: string };
  const r = await k8s('POST', jobsPath(meta.namespace), manifest);
  if (r.status === 201 || r.status === 200) return { ok: true, value: meta.name, at };
  return failure(r.status, `creating Job ${meta.namespace}/${meta.name}`, at);
}

/** Delete a Job and its pods (background propagation). A missing Job is fine. */
export async function deleteJob(k8s: CnpgK8s, ns: string, name: string): Promise<Fetched<boolean>> {
  const at = now();
  const r = await k8s('DELETE', `${jobsPath(ns)}/${name}`, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Background' });
  if (r.status === 200 || r.status === 202) return { ok: true, value: true, at };
  if (r.status === 404) return { ok: true, value: false, at };
  return failure(r.status, `deleting Job ${ns}/${name}`, at);
}

/** The tail of the log of the Job's newest pod (`job-name` label set by the Job controller). '' when no pod is left. */
export async function jobLogTail(k8s: CnpgK8s, k8sText: CnpgK8sText, ns: string, job: string, tailLines = 60): Promise<Fetched<string>> {
  const at = now();
  const pods = await k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${job}`)}`);
  if (pods.status !== 200) return failure(pods.status, `listing the pods of Job ${ns}/${job}`, at);
  const items = ((pods.body.items ?? []) as { metadata: { name: string; creationTimestamp?: string } }[]).sort((a, b) =>
    String(b.metadata.creationTimestamp ?? '').localeCompare(String(a.metadata.creationTimestamp ?? '')),
  );
  if (!items.length) return { ok: true, value: '', at };
  const log = await k8sText(`/api/v1/namespaces/${ns}/pods/${items[0].metadata.name}/log?tailLines=${tailLines}`);
  if (log.status !== 200) return failure(log.status, `reading the log of Job ${ns}/${job}`, at);
  return { ok: true, value: log.text, at };
}

/** Merge-patch the pod template annotations of a Deployment (a rollout). A missing Deployment is `false`, not an error. */
export async function annotatePodTemplate(k8s: CnpgK8s, ns: string, deployment: string, annotations: Record<string, string>): Promise<Fetched<boolean>> {
  const at = now();
  const r = await k8s('PATCH', `/apis/apps/v1/namespaces/${ns}/deployments/${deployment}`, { spec: { template: { metadata: { annotations } } } });
  if (r.status === 200) return { ok: true, value: true, at };
  if (r.status === 404) return { ok: true, value: false, at };
  return failure(r.status, `rolling Deployment ${ns}/${deployment}`, at);
}

/**
 * Health of the app database cluster in the Dev namespace, from CNPG's own status (`status.phase`, ready instances).
 * CNPG has no version endpoint for a Cluster: `version` is the image the Cluster runs (its own `status.image`).
 */
export const cnpgAdapter: Adapter = {
  id: 'cnpg-apps',
  async health(): Promise<Fetched<ComponentHealth>> {
    const r = await readCluster(liveCnpgK8s, config.appsDevNamespace, config.appDatabasesCluster);
    if (!r.ok) return r;
    const ready = r.value.readyInstances >= r.value.instances && r.value.instances > 0;
    return { ok: true, at: r.at, value: { version: r.value.imageName || null, status: ready ? 'ready' : 'degraded', detail: r.value.phase } };
  },
};

function failure(status: number, what: string, at: string): Fetched<never> {
  const reason = status === 0 ? 'unreachable' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid';
  return { ok: false, reason, detail: `${what}: HTTP ${status}`, at };
}
