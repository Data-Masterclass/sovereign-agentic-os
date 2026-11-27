/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Zot adapter (App Builder, workstream C1): the one door through which the OS reaches the platform
 *             registry and the per-domain push credential.
 * USER STORY: As a builder I want my domain's first build to get its own push credential automatically, and the deploy
 *             to refuse a digest the registry does not hold; as an operator I want no other domain's credential, and no
 *             registry password, ever to pass through a place it does not belong.
 * ARCHITECTURE (spec 6.2, 2b):
 *   - Names, all derived from the DOMAIN (slugs are unique per domain only): `domainKey` = the domain in [a-z0-9-] (cut)
 *     + "-" + 8 hex of sha256(domain), so two domains never share a key; repository `apps/<domainKey>/<slug>`; Zot user
 *     `push-<domainKey>`; Secret `zot-push-<domainKey>` in the build namespace. The Tekton listener's CEL filter binds the
 *     Secret to the repository by exactly this rule (charts/.../software-tekton.yaml).
 *   - `ensurePushCredential`: creates the domain's push Secret once (random password, dockerconfigjson for the
 *     in-cluster registry), never reads a password back, then starts the chart's `zot-users` reconcile now (a Job from
 *     its CronJob's template) - our Go tool renders Zot's bcrypt htpasswd and access control; os-ui hashes nothing.
 *   - `digestExists`: HEAD the manifest with the read-only pull identity (Secret `zot-pull`): the OCI distribution API,
 *     https://github.com/opencontainers/distribution-spec/blob/main/spec.md#checking-if-content-exists-in-the-registry.
 *   Kubernetes and HTTP are injected (tests use a real local HTTP server and a recorded API); nothing is retried or
 *   defaulted here: callers get the status or a typed failure.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';
import { k8s as liveK8s } from '@core/infra/k8s';

export type ZotK8s = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
export const liveZotK8s: ZotK8s = liveK8s as ZotK8s;

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DOMAIN_KEY_PREFIX_MAX = 40;
/** The root of every app image REPOSITORY in the platform registry (OCI names, spec 6.2) - not a git path of the domain
 *  repository layout (core/infra/repo-layout), which merely shares the word. */
const REGISTRY_APPS_ROOT = 'apps';

/** `<domain in [a-z0-9-], ≤ 40>-<8 hex of sha256(domain)>`: stable, collision-free across domains, a DNS label. */
export function domainKey(domain: string): string {
  if (!domain) throw new Error('domainKey: empty domain');
  const h8 = createHash('sha256').update(domain, 'utf8').digest('hex').slice(0, 8);
  const base = domain.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, DOMAIN_KEY_PREFIX_MAX).replace(/-$/, '');
  return base ? `${base}-${h8}` : h8;
}
export const pushUserName = (domain: string): string => `push-${domainKey(domain)}`;
export const pushSecretName = (domain: string): string => `zot-push-${domainKey(domain)}`;
/** `apps/<domainKey>/<slug>`; refuses a slug outside the listener's grammar rather than altering it. */
export function imageRepository(domain: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`imageRepository: slug "${slug}" is not [a-z0-9-] (1-63, no leading/trailing dash)`);
  return [REGISTRY_APPS_ROOT, domainKey(domain), slug].join('/');
}

export type ZotDeps = { k8s: ZotK8s; buildNamespace: string; platformNamespace: string; registryHost: string; random?: () => string; now?: () => Date };
const liveDeps = (): ZotDeps => ({
  k8s: liveZotK8s, buildNamespace: config.softwareTektonNamespace, platformNamespace: config.platformNamespace, registryHost: config.appRegistry,
});

/** The Secret os-ui writes for a domain (exported for the tests; the password is never logged or returned). */
export function pushSecretManifest(domain: string, password: string, registryHost: string, namespace: string): Record<string, unknown> {
  const user = pushUserName(domain);
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const dockerconfig = JSON.stringify({ auths: { [registryHost]: { auth: b64(`${user}:${password}`) } } });
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: pushSecretName(domain), namespace,
      labels: { 'soa.dev/zot-push': 'true', 'app.kubernetes.io/managed-by': 'os-ui' },
      annotations: { 'soa.dev/zot-repository': [REGISTRY_APPS_ROOT, domainKey(domain)].join('/'), 'soa.dev/domain': domain },
    },
    data: { username: b64(user), password: b64(password), '.dockerconfigjson': b64(dockerconfig) },
  };
}

export type PushCredentialResult = { created: boolean; secret: string; reconcileJob: string | null };

/**
 * Make sure the domain's push credential exists; on creation, start the zot-users reconcile so Zot knows the user
 * within seconds rather than at the next scheduled run. A 409 on create (a parallel first build) counts as existing.
 */
export async function ensurePushCredential(domain: string, deps: ZotDeps = liveDeps()): Promise<Fetched<PushCredentialResult>> {
  const at = new Date().toISOString();
  if (!deps.buildNamespace || !deps.registryHost) return { ok: false, reason: 'invalid', detail: 'the build namespace or the platform registry is not configured', at };
  const name = pushSecretName(domain);
  const base = `/api/v1/namespaces/${deps.buildNamespace}/secrets`;
  const got = await deps.k8s('GET', `${base}/${name}`);
  if (got.status === 200) return { ok: true, value: { created: false, secret: name, reconcileJob: null }, at };
  if (got.status !== 404) return failure(got.status, `reading ${name}`, at);
  const password = (deps.random ?? (() => randomBytes(24).toString('hex')))();
  const made = await deps.k8s('POST', base, pushSecretManifest(domain, password, deps.registryHost, deps.buildNamespace));
  if (made.status === 409) return { ok: true, value: { created: false, secret: name, reconcileJob: null }, at };
  if (made.status !== 201 && made.status !== 200) return failure(made.status, `creating ${name}`, at);
  const job = await startReconcile(deps);
  if (!job.ok) return job;
  return { ok: true, value: { created: true, secret: name, reconcileJob: job.value }, at };
}

/** A Job from the `zot-users` CronJob's own template (what `kubectl create job --from=cronjob/zot-users` does). */
export async function startReconcile(deps: ZotDeps): Promise<Fetched<string>> {
  const at = new Date().toISOString();
  const cj = await deps.k8s('GET', `/apis/batch/v1/namespaces/${deps.platformNamespace}/cronjobs/zot-users`);
  if (cj.status !== 200) return failure(cj.status, 'reading cronjob zot-users', at);
  const tpl = ((cj.body.spec as Record<string, unknown> | undefined)?.jobTemplate ?? {}) as { metadata?: Record<string, unknown>; spec?: unknown };
  if (!tpl.spec) return { ok: false, reason: 'invalid', detail: 'cronjob zot-users has no jobTemplate', at };
  const name = `zot-users-${((deps.now ?? (() => new Date()))()).getTime().toString(36)}`;
  const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: deps.platformNamespace, labels: { 'app.kubernetes.io/component': 'zot-users' }, annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' } }, spec: tpl.spec };
  const r = await deps.k8s('POST', `/apis/batch/v1/namespaces/${deps.platformNamespace}/jobs`, job);
  if (r.status !== 201 && r.status !== 200) return failure(r.status, 'creating the zot-users job', at);
  return { ok: true, value: name, at };
}

export type DigestDeps = { fetch: typeof fetch; registryHost: string; pullAuth: () => Promise<string | null> };

/** Does the registry hold `<repository>@<digest>`? true (200), false (404), or a typed failure. */
export async function digestExists(repository: string, digest: string, deps: DigestDeps): Promise<Fetched<boolean>> {
  const at = new Date().toISOString();
  if (!/^apps\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository) || !DIGEST_RE.test(digest)) return { ok: false, reason: 'invalid', detail: `not an app repository and digest: ${repository}@${digest}`, at };
  const auth = await deps.pullAuth();
  if (!auth) return { ok: false, reason: 'unauthorized', detail: 'the registry pull identity (Secret zot-pull) is not readable', at };
  try {
    const res = await deps.fetch(`http://${deps.registryHost}/v2/${repository}/manifests/${digest}`, {
      method: 'HEAD',
      headers: { authorization: `Basic ${auth}`, accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) return { ok: true, value: true, at };
    if (res.status === 404) return { ok: true, value: false, at };
    return failure(res.status, `HEAD ${repository}@${digest}`, at);
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'unreachable', detail: e instanceof Error ? e.message : String(e), at };
  }
}

/** App Builder (C2): `digestExists` against the configured app registry with the read-only pull identity. */
export function liveRegistryDigestExists(repository: string, digest: string): Promise<Fetched<boolean>> {
  return digestExists(repository, digest, { fetch, registryHost: config.appRegistry, pullAuth: livePullAuth() });
}

/** The pull identity as a Basic credential, read from Secret `zot-pull` (os-ui may get exactly that one Secret). */
export function livePullAuth(k8s: ZotK8s = liveZotK8s, namespace: string = config.platformNamespace): () => Promise<string | null> {
  return async () => {
    const r = await k8s('GET', `/api/v1/namespaces/${namespace}/secrets/zot-pull`);
    const data = (r.body.data ?? {}) as Record<string, string>;
    if (r.status !== 200 || !data.username || !data.password) return null;
    const dec = (s: string) => Buffer.from(s, 'base64').toString('utf8');
    return Buffer.from(`${dec(data.username)}:${dec(data.password)}`, 'utf8').toString('base64');
  };
}

// ------------------------------------------------------------------ release tags (App Builder C2) ---
// Spec 6.2 retention: every digest a release record names is tagged `release-<env>-<id>` and kept forever. Those tags are
// RESERVED for a platform identity: C1's Zot policy refuses them to every `push-<domainKey>` user, and os-ui holds no
// registry write credential at all (only the read-only `zot-pull`). So the release flow never writes a tag itself: it
// records the tags an env must keep on the app's Deployment (annotation below, JSON `{ "<tag>": "sha256:…" }`), and the
// platform's keeper identity (C1's `zot-users` retention keeper, which already reads apps-dev/apps-prod for its keep-*
// tags) applies them. Until the keeper reads the annotation, the keep-* tags still protect every RUNNING digest; only a
// rollback target that no pod runs any more depends on the release tag (docs/components/app-builder-releases.md).

export const RELEASE_PINS_ANNOTATION = 'soa.dev/release-tags';
const RELEASE_TAG_RE = /^release-(dev|prod)-[a-z0-9]{1,40}$/;

/** The tags (newest `limit` releases) an env must keep, as the annotation's JSON object. Never a push credential. */
export function releasePins(releases: readonly { env: string; id: string; digest: string }[], limit = 10): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of releases.slice(0, Math.max(0, limit))) {
    const tag = `release-${r.env}-${r.id}`;
    if (RELEASE_TAG_RE.test(tag) && DIGEST_RE.test(r.digest)) out[tag] = r.digest;
  }
  return out;
}

function failure(status: number, what: string, at: string): Fetched<never> {
  const reason = status === 0 ? 'unreachable' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid';
  return { ok: false, reason, detail: `${what}: HTTP ${status}`, at };
}
