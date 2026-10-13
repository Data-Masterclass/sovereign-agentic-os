/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Software golden path — Phase B: the DIRECT BUILD SERVICE.
 *
 * Today a gated commit lands in Forgejo, then Forgejo Actions (a DIND ci-runner)
 * asynchronously runs `npm build` → `docker build` → pushes `:latest` + `:sha12`;
 * the runner then rolls on a pod-template annotation and re-pulls the FLOATING
 * `:latest`. That chain owns three fragilities off the critical path: the Actions
 * runner itself, the `:latest` tag ambiguity, and the roll-on-same-tag hack.
 *
 * This module takes the SERVING image off Forgejo Actions. After a successful gated
 * commit, os-ui submits an in-cluster KANIKO `batch/v1` Job (via the same generic
 * `k8s()` client the Science trainer uses, `lib/science/training.ts`) that:
 *
 *   1. builds the app's committed Dockerfile straight from its Forgejo GIT tree at
 *      the exact commit SHA — Kaniko's native `git://` context, so there is NO
 *      tarball to pack, NO ConfigMap size limit, and NO extra object-store hop. The
 *      durable OpenSearch mirror stays the source of truth for SOURCE (file-mirror.ts);
 *      the git projection is only the build TRANSPORT, and Forgejo already had to be
 *      reachable for the commit to have landed there at all.
 *   2. pushes an IMMUTABLE tag `<registry>/<slug>:<sha12>` to the in-cluster registry
 *      and writes the pushed image DIGEST to the container's termination message
 *      (`--digest-file=/dev/termination-log`) — captured back through the pod's
 *      `state.terminated.message` with only pod-read RBAC (no log-scrape, no Events).
 *
 * Kaniko (not BuildKit) because it needs NO daemon/socket and runs as a plain,
 * unprivileged pod under the apps-namespace Pod Security Standard — BuildKit rootless
 * would add a daemon + socket + relaxed security to stand up. The pushed digest then
 * feeds the runner (`runner.ts`), which serves the app DIGEST-PINNED — a new digest is
 * a real template change, so Kubernetes rolls honestly and the `:latest` roll hack is
 * deleted.
 *
 * PURE + dependency-injected (no `server-only`, no top-level VALUE `@/` imports) so it
 * unit-tests under `node --test`; the single live dependency (the k8s API) is INJECTED
 * as `K8sClient`, default-bound by a dynamic import inside submit/read. Never throws on
 * an unreachable cluster — it degrades to an honest `unreachable`/`unknown`, and the old
 * Forgejo Actions path still serves (this service is FEATURE-FLAGGED, default OFF).
 */

/** Minimal k8s client surface — matches `lib/infra/k8s.ts` `k8s(method, path, body)`. */
export type K8sClient = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * The cluster + registry wiring the build Job needs — injected from `config` so this
 * module holds no secrets and stays test-safe. The registry credentials are the SAME
 * admin basic-auth the Forgejo git clone and CI registry push already use.
 */
export type BuildRuntime = {
  namespace: string;
  /** Pinned kaniko executor image (repo:tag). */
  kanikoImage: string;
  /** Registry host (no scheme), e.g. `forgejo-http:3000`. Push target host. */
  registryHost: string;
  /** Registry owner path, e.g. `gitea_admin`. Image repo is `<host>/<owner>/<slug>`. */
  registryOwner: string;
  /** Forgejo base URL WITHOUT scheme+creds, e.g. `forgejo-http:3000` — the git host. */
  gitHost: string;
  /** Basic-auth user for BOTH the git clone and the registry push (admin credential). */
  authUser: string;
  /** Basic-auth password — injected, never inlined into the module. */
  authPassword: string;
  /** OS API base URL baked into the SPA at build time (VITE_OS_API → ARG OS_API_URL). */
  osApiUrl: string;
};

/** A build handle the caller records + polls on. */
export type BuildRun = {
  slug: string;
  sha: string;
  jobName: string;
  namespace: string;
  /** The immutable tag ref this build pushes (`<registry>/<slug>:<sha12>`). */
  imageTag: string;
};

export type BuildPhase = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';

export type BuildStatus = {
  jobName: string;
  phase: BuildPhase;
  /** True while the cluster is reachable and the Job exists. */
  active: boolean;
  /** A short human reason (pod waiting reason / last condition) for the status card. */
  reason: string;
  /**
   * The pushed image DIGEST ref (`<registry>/<slug>@sha256:…`) once the build SUCCEEDED
   * and the digest was captured; null otherwise. This is what the runner pins to.
   */
  imageDigest: string | null;
  /** The Job's creationTimestamp (ISO) — lets the caller enforce a build deadline. */
  createdAt?: string;
};

// ------------------------------------------------------------------ naming ---------

/** The first 12 chars of a commit SHA — the immutable per-build tag. */
export function shortSha(sha: string): string {
  return (sha || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 12);
}

/** The image REPO (no tag) for an app: `<host>/<owner>/<slug>`. */
export function imageRepoFor(rt: BuildRuntime, slug: string): string {
  return `${rt.registryHost}/${rt.registryOwner}/${slug}`;
}

/** The immutable per-commit TAG ref: `<host>/<owner>/<slug>:<sha12>`. */
export function imageTagFor(rt: BuildRuntime, slug: string, sha: string): string {
  return `${imageRepoFor(rt, slug)}:${shortSha(sha)}`;
}

/** A DNS-1123 Job name unique per (slug, sha) — a re-build of the same commit is idempotent. */
export function buildJobName(slug: string, sha: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 34);
  return `build-${s || 'app'}-${shortSha(sha) || 'head'}`.slice(0, 52).replace(/-+$/g, '');
}

// ---------------------------------------------------- docker config for the push ---

/**
 * The `/kaniko/.docker/config.json` Kaniko reads to authenticate the PUSH. One
 * basic-auth entry for the in-cluster registry host — the same admin credential the
 * CI workflow logs in with. Kept a pure builder so the test asserts its exact shape
 * (and that the password is present but never widened beyond the registry host).
 */
export function dockerConfigJson(rt: BuildRuntime): string {
  const auth = Buffer.from(`${rt.authUser}:${rt.authPassword}`).toString('base64');
  return JSON.stringify({ auths: { [rt.registryHost]: { auth } } });
}

/**
 * The git CONTEXT ref Kaniko clones the build from: `git://<host>/<owner>/<slug>.git#<sha>`.
 * Auth rides via the GIT_USERNAME/GIT_PASSWORD env Kaniko honours for git contexts, so the
 * credential is never embedded in this URL (no secret in the manifest text).
 */
export function gitContextRef(rt: BuildRuntime, slug: string, sha: string): string {
  return `git://${rt.gitHost}/${rt.registryOwner}/${slug}.git#${sha}`;
}

// ------------------------------------------------------------------ the Job spec ---

/**
 * Build the batch/v1 Job manifest for one app-commit build — the PURE core (no cluster,
 * no live secrets beyond what the injected runtime carries). A SINGLE kaniko container:
 *
 *   • `--context` = the app's Forgejo git tree at the commit SHA (`git://…#<sha>`),
 *   • `--dockerfile=Dockerfile` (the scaffold ships one — multi-stage node→nginx:8080),
 *   • `--destination` = the immutable `:<sha12>` tag,
 *   • `--build-arg OS_API_URL=…` so the SPA bakes the right OS base URL (parity with the
 *      Forgejo-Actions Dockerfile ARG),
 *   • `--digest-file=/dev/termination-log` so the pushed DIGEST surfaces in the pod's
 *      `state.terminated.message` (captured with pod-read RBAC only),
 *   • `--insecure --skip-tls-verify` because the in-cluster Forgejo registry is plain HTTP.
 *
 * The docker auth config is provided as an env `DOCKER_CONFIG` dir populated from an
 * emptyDir an init step writes — but to stay daemonless AND dependency-free we instead
 * pass the config via the `DOCKER_CONFIG` env pointing at a projected file written from
 * a small `sh -c` prelude in an init container. Kept out of the pure builder: the auth
 * secret lives in the init container's arg, built here from the injected runtime.
 */
export function buildKanikoJob(
  slug: string,
  sha: string,
  rt: BuildRuntime,
  jobName: string,
): Record<string, unknown> {
  const destination = imageTagFor(rt, slug, sha);
  const context = gitContextRef(rt, slug, sha);
  const dockerConfig = dockerConfigJson(rt);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: rt.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'os-ui',
        'sovereign-os/component': 'app-builder',
        'sovereign-os/app': slug,
      },
    },
    spec: {
      backoffLimit: 0,
      // Reap the finished Job (and its pod) an hour later so re-builds of the SAME
      // (slug, sha) never 409 on a stale completed Job, and the namespace stays clean.
      ttlSecondsAfterFinished: 3600,
      // A build that cannot pull/clone/push within 15 min is stuck — fail honestly.
      activeDeadlineSeconds: 900,
      template: {
        metadata: {
          labels: { 'sovereign-os/component': 'app-builder', 'sovereign-os/app': slug },
        },
        spec: {
          restartPolicy: 'Never',
          // An init container writes the registry auth config to a shared emptyDir so
          // the kaniko container reads it via DOCKER_CONFIG — no in-cluster Secret to
          // provision (least new infra), and the credential lives only in this Job's
          // ephemeral pod. Uses busybox `sh` (present in the kaniko debug base too,
          // but a tiny busybox keeps the kaniko container's args clean).
          initContainers: [
            {
              name: 'docker-config',
              image: rt.kanikoImage,
              // The kaniko image ships `/busybox/sh`; write the config with it.
              command: ['/busybox/sh', '-c'],
              args: [
                // Single-quote the JSON so the shell never interpolates it; write to the
                // shared dir kaniko mounts as DOCKER_CONFIG.
                `printf '%s' '${dockerConfig}' > /kaniko/.docker/config.json`,
              ],
              volumeMounts: [{ name: 'docker-config', mountPath: '/kaniko/.docker' }],
            },
          ],
          containers: [
            {
              name: 'kaniko',
              image: rt.kanikoImage,
              args: [
                `--context=${context}`,
                '--dockerfile=Dockerfile',
                `--destination=${destination}`,
                `--build-arg=OS_API_URL=${rt.osApiUrl}`,
                '--digest-file=/dev/termination-log',
                // The in-cluster Forgejo registry serves plain HTTP.
                '--insecure',
                '--skip-tls-verify',
                // Git context over plain HTTP too.
                '--insecure-pull',
                // Deterministic, cache-friendly single-snapshot build.
                '--single-snapshot',
              ],
              env: [
                { name: 'DOCKER_CONFIG', value: '/kaniko/.docker' },
                // Kaniko honours these for the `git://` context clone (no creds in the URL).
                { name: 'GIT_USERNAME', value: rt.authUser },
                { name: 'GIT_PASSWORD', value: rt.authPassword },
              ],
              volumeMounts: [{ name: 'docker-config', mountPath: '/kaniko/.docker' }],
              resources: {
                requests: { cpu: '250m', memory: '1Gi' },
                limits: { cpu: '2', memory: '4Gi' },
              },
            },
          ],
          volumes: [{ name: 'docker-config', emptyDir: {} }],
        },
      },
    },
  };
}

// ------------------------------------------------- feature flag + honest OFF note --

/** True when the direct build service is enabled AND its runtime is wired. */
export function buildServiceEnabled(cfg: {
  softwareBuildEnabled: boolean;
  harborRegistry: string;
}): boolean {
  return cfg.softwareBuildEnabled === true && !!cfg.harborRegistry;
}

/**
 * The honest note when the build service is OFF — states WHY (flag off / RBAC not
 * granted by the chart) and that the Forgejo Actions path still builds the serving
 * image. Surfaced on the pipeline so the status card never implies a build ran here.
 */
export const BUILD_SERVICE_OFF_NOTE =
  'OS build service is OFF (SOFTWARE_BUILD_SERVICE not enabled / build-Job RBAC not granted) — ' +
  'the serving image is built by Forgejo Actions as before; enable softwareBuild in the chart to ' +
  'build in-cluster with Kaniko and pin the runner to the pushed digest.';

// --------------------------------------------------------- submit + poll (injected) --

/** Default binding: the in-cluster k8s client (dynamic so `node --test` skips the alias). */
async function defaultK8s(): Promise<K8sClient> {
  const { k8s } = await import('@/lib/infra/k8s');
  return k8s;
}

/**
 * Submit an app-commit build Job to the cluster. Pure spec build + one POST to the
 * batch/v1 Jobs API via the injected client. A 409 (the same (slug, sha) Job already
 * exists / still running) is NOT an error — the build is already in flight; we return
 * the same handle so the caller polls it. Returns an honest, status-tagged result.
 */
export async function submitBuildJob(
  slug: string,
  sha: string,
  rt: BuildRuntime,
  client?: K8sClient,
): Promise<{ ok: boolean; reachable: boolean; run: BuildRun; detail: string }> {
  const jobName = buildJobName(slug, sha);
  const run: BuildRun = { slug, sha, jobName, namespace: rt.namespace, imageTag: imageTagFor(rt, slug, sha) };
  if (!shortSha(sha)) {
    return { ok: false, reachable: true, run, detail: 'No commit SHA to build — nothing was submitted.' };
  }
  const k = client ?? (await defaultK8s());
  const manifest = buildKanikoJob(slug, sha, rt, jobName);
  const res = await k('POST', `/apis/batch/v1/namespaces/${rt.namespace}/jobs`, manifest);
  if (res.status === 0) {
    return { ok: false, reachable: false, run, detail: 'Kubernetes API unreachable — the OS build service could not submit the build Job.' };
  }
  if (res.status === 409) {
    return { ok: true, reachable: true, run, detail: `A build for ${slug}@${shortSha(sha)} is already in flight (Job ${jobName}).` };
  }
  if (res.status === 403 || res.status === 404) {
    // RBAC missing / namespace absent — the specific fallback case: say so, honestly.
    return {
      ok: false,
      reachable: true,
      run,
      detail:
        `The OS build service lacks permission to submit a build Job in ${rt.namespace} (HTTP ${res.status}) — ` +
        'the chart has not granted the build-Job RBAC. The Forgejo Actions path still builds the image.',
    };
  }
  if (res.status >= 300) {
    const msg = (res.body?.message as string) || `Kubernetes rejected the build Job (HTTP ${res.status})`;
    return { ok: false, reachable: true, run, detail: msg };
  }
  return { ok: true, reachable: true, run, detail: `Submitted OS build Job ${jobName} → ${run.imageTag}.` };
}

/** Map a k8s Job `.status` block onto our coarse build phase. */
export function jobPhase(status: Record<string, unknown> | undefined): BuildPhase {
  if (!status) return 'unknown';
  if (typeof status.succeeded === 'number' && status.succeeded > 0) return 'succeeded';
  if (typeof status.failed === 'number' && status.failed > 0) return 'failed';
  if (typeof status.active === 'number' && status.active > 0) return 'running';
  return 'pending';
}

/**
 * Capture the pushed image DIGEST from the build pod's terminated kaniko container.
 * Kaniko writes `--digest-file=/dev/termination-log`, which Kubernetes surfaces as the
 * container's `state.terminated.message`. We fetch the Job's pod, find the `kaniko`
 * container's terminated message, and pin the digest to the FULL immutable ref
 * `<registry>/<slug>@<digest>`. Best-effort: any hiccup / non-digest message → null.
 */
export function parseDigest(message: string | undefined | null): string | null {
  if (!message) return null;
  // Kaniko writes the bare `sha256:<64 hex>` (sometimes with trailing whitespace/newline).
  const m = /sha256:[a-f0-9]{64}/i.exec(message);
  return m ? m[0].toLowerCase() : null;
}

/** The full digest-pinned image ref the runner serves: `<registry>/<slug>@sha256:…`. */
export function digestRef(rt: BuildRuntime, slug: string, digest: string): string {
  return `${imageRepoFor(rt, slug)}@${digest}`;
}

async function captureBuildDigest(
  slug: string,
  jobName: string,
  rt: BuildRuntime,
  client: K8sClient,
): Promise<string | null> {
  const res = await client('GET', `/api/v1/namespaces/${rt.namespace}/pods?labelSelector=job-name%3D${jobName}`);
  if (res.status !== 200) return null;
  const pods = (res.body?.items as Record<string, unknown>[] | undefined) ?? [];
  for (const pod of pods) {
    const st = (pod.status ?? {}) as Record<string, unknown>;
    const statuses = (st.containerStatuses as
      | { name?: string; state?: { terminated?: { message?: string } } }[]
      | undefined) ?? [];
    const kaniko = statuses.find((c) => c.name === 'kaniko') ?? statuses[0];
    const digest = parseDigest(kaniko?.state?.terminated?.message);
    if (digest) return digestRef(rt, slug, digest);
  }
  return null;
}

/**
 * Reuse the pod's own waiting reason (ImagePullBackOff, unschedulable, …) for a pending
 * build — pod-read RBAC only, no Events. Best-effort: any hiccup returns ''.
 */
export async function podPendingReason(
  jobName: string,
  namespace: string,
  client: K8sClient,
): Promise<string> {
  const res = await client('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${jobName}`);
  if (res.status !== 200) return '';
  const pods = (res.body?.items as Record<string, unknown>[] | undefined) ?? [];
  for (const pod of pods) {
    const st = (pod.status ?? {}) as Record<string, unknown>;
    const statuses = [
      ...((st.initContainerStatuses as { state?: { waiting?: { reason?: string; message?: string } } }[] | undefined) ?? []),
      ...((st.containerStatuses as { state?: { waiting?: { reason?: string; message?: string } } }[] | undefined) ?? []),
    ];
    for (const c of statuses) {
      const w = c.state?.waiting;
      if (w?.reason && w.reason !== 'PodInitializing' && w.reason !== 'ContainerCreating') {
        return w.message ? `${w.reason}: ${w.message}` : w.reason;
      }
    }
    const conds = (st.conditions as { type?: string; status?: string; message?: string }[] | undefined) ?? [];
    const unsched = conds.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    if (unsched?.message) return unsched.message;
  }
  return '';
}

/**
 * Read a build Job's status (poll). Never throws — an unreachable API is `unknown`. On
 * a SUCCEEDED build it also captures the pushed digest so the caller can pin the runner.
 */
export async function readBuildJob(
  slug: string,
  jobName: string,
  rt: BuildRuntime,
  client?: K8sClient,
): Promise<BuildStatus> {
  const k = client ?? (await defaultK8s());
  const res = await k('GET', `/apis/batch/v1/namespaces/${rt.namespace}/jobs/${jobName}`);
  if (res.status === 0 || res.status >= 400) {
    return {
      jobName,
      phase: 'unknown',
      active: false,
      reason: res.status === 404 ? 'build job not found' : 'cluster unreachable',
      imageDigest: null,
    };
  }
  const status = res.body?.status as Record<string, unknown> | undefined;
  const meta = res.body?.metadata as { creationTimestamp?: string } | undefined;
  const phase = jobPhase(status);
  const conditions = (status?.conditions as { message?: string }[] | undefined) ?? [];
  let reason = conditions[conditions.length - 1]?.message ?? phase;
  let imageDigest: string | null = null;
  if (phase === 'pending') {
    const podReason = await podPendingReason(jobName, rt.namespace, k);
    if (podReason) reason = podReason;
  } else if (phase === 'succeeded') {
    imageDigest = await captureBuildDigest(slug, jobName, rt, k);
    reason = imageDigest ? 'built + pushed (digest pinned)' : 'built, but the pushed digest could not be captured';
  }
  return {
    jobName,
    phase,
    active: phase === 'running' || phase === 'pending',
    reason,
    imageDigest,
    createdAt: meta?.creationTimestamp,
  };
}
