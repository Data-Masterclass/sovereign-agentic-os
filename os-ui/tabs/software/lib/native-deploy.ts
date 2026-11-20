/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    WP-54 — an app's build and deploy code is NATIVE code in its own tree
 * USER STORY: As an engineer I want my app to be a normal repository: a Dockerfile, plain
 *             Kubernetes manifests and a CI workflow I can run with `docker build` and
 *             `kubectl apply` on any cluster — and I want the OS to deploy exactly those files,
 *             not objects it invents in memory.
 * ARCHITECTURE:
 *   - The tree: `apps/<slug>/Dockerfile` (from the scaffold), `apps/<slug>/k8s/{deployment,service,
 *     ingress}.yaml` and `apps/<slug>/.github/workflows/image.yml`. Paths come from
 *     `core/infra/repo-layout.ts`. Eject: `docker build`, push, `kubectl apply -n <ns> -f k8s/`.
 *   - WHAT RUNS IS WHAT IS IN GIT (artifact contract C4). `planAppDeploy` returns the committed
 *     objects UNCHANGED; the runner only sets `metadata.namespace` (what `kubectl apply -n` does)
 *     and submits them to the Kubernetes API, dry-run first. Kubernetes validates the schema and
 *     the namespace's Pod Security `restricted` admission — the OS re-implements neither.
 *   - The OS's OWN rules (governance, not Kubernetes semantics), checked here and at the receive
 *     gate with the same function:
 *       1. kinds: Deployment, Service, Ingress only — network isolation and RBAC are the platform's;
 *       2. every object is named `app-<slug>` and carries no namespace;
 *       3. every image is `<platform registry>/<slug>@sha256:<digest>`: a registry the platform
 *          owns and keeps (`softwareRunner.imageRegistry`), content-addressed, never a tag;
 *       4. an Ingress serves only the app's own host; containers declare resources; no custom
 *          ServiceAccount.
 *   - THE OS BUILDS NO IMAGES (07 B8-7). The image is built by the app's CI workflow (or any OCI
 *     builder) and pushed to the platform registry; the digest is then committed into
 *     `k8s/deployment.yaml`. Until it is, the scaffold carries the all-zero digest and a deploy is
 *     refused with `image_not_built`.
 *   - Pure: no fs, no network, no env. Unit-tested in native-deploy.test.ts; the real-cluster
 *     proof (dry-run admission, apply, serve, eject) is app-eject.kind.test.ts.
 */
import yaml from 'js-yaml';
import { APP_K8S_DIR, APP_CI_WORKFLOW_PATH, APPS_DIR } from '@core/infra/repo-layout';

export { APP_K8S_DIR };
export const APP_CI_WORKFLOW = APP_CI_WORKFLOW_PATH;

/** The digest a scaffold carries before its first image build. A deploy refuses it. */
export const NOT_BUILT_DIGEST = `sha256:${'0'.repeat(64)}`;

/** The port every scaffold's container listens on (the Dockerfiles EXPOSE 8080). */
export const APP_PORT = 8080;

type Obj = Record<string, unknown>;
type File = { path: string; content: string };

/** Deterministic, RFC1123-safe object name for an app (one object set per app). */
export function runnerName(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `app-${s || 'app'}`.slice(0, 52).replace(/-+$/g, '');
}

/** `<registry>/<slug>` — the one repository an app may pull from. */
export function appImageRepository(registry: string, slug: string): string {
  return `${registry.replace(/\/+$/, '')}/${slug}`;
}

export type DeployContext = {
  slug: string;
  /** The app's own host, `<slug>.<domain>.<appsDomain>`. */
  host: string;
  /** The platform registry prefix (`softwareRunner.imageRegistry`); empty = not configured. */
  registry: string;
  ingressClass?: string;
  tlsIssuer?: string;
  priorityClassName?: string;
};

// ------------------------------------------------------------------ scaffold ---

const ACTIONS = {
  checkout: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', // v4.2.2, MIT
  buildx: 'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069', // v4.4.1, Apache-2.0
  login: 'docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550', // v4.8.0, Apache-2.0
  build: 'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc', // v7.4.0, Apache-2.0
} as const;

/**
 * The native deploy files for an app: three manifests and the image workflow. The Dockerfile comes
 * from the template's scaffold. `digest` defaults to {@link NOT_BUILT_DIGEST}.
 */
export function appDeployFiles(c: DeployContext & { digest?: string }): File[] {
  const name = runnerName(c.slug);
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'sovereign-os-apps' };
  const image = `${appImageRepository(c.registry || 'REGISTRY-NOT-CONFIGURED', c.slug)}@${c.digest ?? NOT_BUILT_DIGEST}`;
  const header = (what: string) =>
    `# ${what} for app '${c.slug}'. Plain Kubernetes: kubectl apply -n <namespace> -f k8s/\n`;

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      template: {
        metadata: { labels },
        spec: {
          ...(c.priorityClassName ? { priorityClassName: c.priorityClassName } : {}),
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          // The web server's temp and pid files go to a small in-memory /tmp, not the node's disk.
          volumes: [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
          containers: [
            {
              name: 'app',
              image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'http', containerPort: APP_PORT }],
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '1', memory: '64Mi' } },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              readinessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 6 },
            },
          ],
        },
      },
    },
  };
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, labels },
    spec: { selector: { 'app.kubernetes.io/name': name }, ports: [{ name: 'http', port: 80, targetPort: 'http' }] },
  };
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name, labels, ...(c.tlsIssuer ? { annotations: { 'cert-manager.io/cluster-issuer': c.tlsIssuer } } : {}) },
    spec: {
      ...(c.ingressClass ? { ingressClassName: c.ingressClass } : {}),
      tls: [{ hosts: [c.host], secretName: `${c.host}-tls` }],
      rules: [
        {
          host: c.host,
          http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 80 } } } }] },
        },
      ],
    },
  };
  const workflow = {
    name: 'image',
    on: { push: { branches: ['main'] }, workflow_dispatch: {} },
    permissions: { contents: 'read', packages: 'write' },
    env: { IMAGE: appImageRepository(c.registry || 'REGISTRY-NOT-CONFIGURED', c.slug) },
    jobs: {
      image: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: ACTIONS.checkout },
          { uses: ACTIONS.buildx },
          {
            uses: ACTIONS.login,
            with: {
              registry: '${{ vars.APP_REGISTRY_HOST }}',
              username: '${{ vars.APP_REGISTRY_USER }}',
              password: '${{ secrets.APP_REGISTRY_TOKEN }}',
            },
          },
          { id: 'build', uses: ACTIONS.build, with: { context: '.', push: true, tags: '${{ env.IMAGE }}:${{ github.sha }}' } },
          {
            name: 'Digest to pin in k8s/deployment.yaml',
            run: 'echo "image: ${IMAGE}@${{ steps.build.outputs.digest }}" >> "$GITHUB_STEP_SUMMARY"',
          },
        ],
      },
    },
  };
  const dump = (o: unknown) => yaml.dump(o, { lineWidth: 120, noRefs: true });
  return [
    { path: `${APP_K8S_DIR}/deployment.yaml`, content: header('Deployment') + dump(deployment) },
    { path: `${APP_K8S_DIR}/service.yaml`, content: header('Service') + dump(service) },
    { path: `${APP_K8S_DIR}/ingress.yaml`, content: header('Ingress') + dump(ingress) },
    {
      path: APP_CI_WORKFLOW,
      content:
        `# Builds this app's Dockerfile and pushes it to the platform registry (GitHub-Actions format).\n` +
        `# It runs where this folder is a repository on a forge that runs such workflows; the OS itself\n` +
        `# runs no CI and builds no images. Pin the digest it prints into k8s/deployment.yaml.\n` +
        dump(workflow),
    },
  ];
}

// ------------------------------------------------------------------- validate ---

const ALLOWED_KINDS: Record<string, string> = {
  Deployment: 'apps/v1',
  Service: 'v1',
  Ingress: 'networking.k8s.io/v1',
};

const DIGEST_RE = /@sha256:[a-f0-9]{64}$/;

export type DeployRefusal = {
  ok: false;
  code: 'no_manifests' | 'invalid' | 'image_registry' | 'image_not_built' | 'no_registry';
  reason: string;
};
export type DeployPlan = { ok: true; objects: Obj[]; image: string } | DeployRefusal;

/** True for `apps/<slug>/k8s/**.y(a)ml`. */
export function isAppDeployPath(path: string): boolean {
  return new RegExp(`^${APPS_DIR}/[a-z0-9][a-z0-9-]*/${APP_K8S_DIR}/.+\\.ya?ml$`).test(path);
}

function isK8sFile(path: string): boolean {
  return path.startsWith(`${APP_K8S_DIR}/`) && /\.ya?ml$/.test(path);
}

function parseDocs(file: File): { docs: Obj[] } | { error: string } {
  try {
    const docs = yaml.loadAll(file.content).filter((d) => d !== null && d !== undefined);
    for (const d of docs) if (typeof d !== 'object' || Array.isArray(d)) return { error: `${file.path}: a document is not a Kubernetes object` };
    return { docs: docs as Obj[] };
  } catch (e) {
    return { error: `${file.path}: YAML does not parse (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
  }
}

function podContainers(dep: Obj): Obj[] {
  const pod = ((((dep.spec ?? {}) as Obj).template ?? {}) as Obj).spec as Obj | undefined;
  return [...(((pod?.containers ?? []) as Obj[]) || []), ...(((pod?.initContainers ?? []) as Obj[]) || [])];
}

type Issue = { code: DeployRefusal['code']; reason: string };

/** The OS rules for ONE object. `host` is checked only when known (deploy time). */
function objectIssues(o: Obj, where: string, slug: string, registry: string, host?: string): Issue[] {
  const out: Issue[] = [];
  const kind = String(o.kind ?? '');
  const meta = (o.metadata ?? {}) as Obj;
  const name = runnerName(slug);
  const bad = (reason: string) => out.push({ code: 'invalid', reason: `${where}: ${reason}` });
  if (!(kind in ALLOWED_KINDS)) {
    bad(`kind '${kind || '?'}' is not allowed; an app may commit only ${Object.keys(ALLOWED_KINDS).join(', ')} (network isolation and access are the platform's)`);
    return out;
  }
  if (o.apiVersion !== ALLOWED_KINDS[kind]) bad(`${kind} must be apiVersion ${ALLOWED_KINDS[kind]}`);
  if (meta.name !== name) bad(`${kind} must be named '${name}' (found '${String(meta.name ?? '')}')`);
  if (meta.namespace !== undefined) bad(`${kind} must not set a namespace (the deploy chooses it, like kubectl apply -n)`);
  if (kind === 'Deployment') {
    const pod = ((((o.spec ?? {}) as Obj).template ?? {}) as Obj).spec as Obj | undefined;
    const sa = pod?.serviceAccountName ?? pod?.serviceAccount;
    if (sa !== undefined && sa !== 'default') bad(`serviceAccountName '${String(sa)}' is not allowed`);
    const containers = podContainers(o);
    if (containers.length === 0) bad('the Deployment has no containers');
    const repo = appImageRepository(registry, slug);
    for (const c of containers) {
      const image = String(c.image ?? '');
      const res = (c.resources ?? {}) as Obj;
      const req = (res.requests ?? {}) as Obj;
      const lim = (res.limits ?? {}) as Obj;
      if (!req.cpu || !req.memory || !lim.memory) bad(`container '${String(c.name)}' must declare resources (requests cpu+memory, limits memory)`);
      if (!registry) continue;
      const repoOf = image.replace(/@sha256:.*$/, '').replace(/:[^/]+$/, '');
      if (repoOf !== repo || !DIGEST_RE.test(image)) {
        out.push({
          code: 'image_registry',
          reason:
            `${where}: image '${image}' is not allowed. An app runs only an image from the platform registry, ` +
            `pinned by digest: ${repo}@sha256:<digest>.`,
        });
      } else if (image.endsWith(NOT_BUILT_DIGEST)) {
        out.push({
          code: 'image_not_built',
          reason:
            `${where}: the image has not been built yet. Build the Dockerfile (the app's CI workflow, or ` +
            `docker build + docker push to ${repo}), then commit the digest into ${APP_K8S_DIR}/deployment.yaml.`,
        });
      }
    }
  }
  if (kind === 'Ingress' && host) {
    const spec = (o.spec ?? {}) as Obj;
    const hosts = [
      ...((spec.rules ?? []) as Obj[]).map((r) => r.host),
      ...((spec.tls ?? []) as Obj[]).flatMap((t) => (t.hosts ?? []) as unknown[]),
    ];
    if (hosts.length === 0 || hosts.some((h) => h !== host)) bad(`the Ingress may serve only the app's host '${host}'`);
    if ((spec as Obj).defaultBackend) bad('the Ingress may not set a defaultBackend');
  }
  return out;
}

/**
 * The deploy plan for an app tree (paths relative to `apps/<slug>/`): the committed objects,
 * unchanged, or a typed refusal naming what to fix. Never throws.
 */
export function planAppDeploy(files: File[], c: DeployContext): DeployPlan {
  const k8sFiles = files.filter((f) => isK8sFile(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (k8sFiles.length === 0) {
    return {
      ok: false,
      code: 'no_manifests',
      reason:
        `This app has no deploy manifests committed under ${APP_K8S_DIR}/. The OS deploys only the ` +
        `Kubernetes files in the app's tree; add ${APP_K8S_DIR}/deployment.yaml, service.yaml and ingress.yaml.`,
    };
  }
  if (!c.registry) {
    return {
      ok: false,
      code: 'no_registry',
      reason: 'No platform image registry is configured (chart value softwareRunner.imageRegistry), so no app image can be deployed.',
    };
  }
  const objects: Obj[] = [];
  const issues: Issue[] = [];
  for (const f of k8sFiles) {
    const parsed = parseDocs(f);
    if ('error' in parsed) {
      issues.push({ code: 'invalid', reason: parsed.error });
      continue;
    }
    for (const d of parsed.docs) {
      issues.push(...objectIssues(d, f.path, c.slug, c.registry, c.host));
      objects.push(d);
    }
  }
  const deployments = objects.filter((o) => o.kind === 'Deployment');
  if (issues.length === 0 && deployments.length !== 1) issues.push({ code: 'invalid', reason: `exactly one Deployment is required (found ${deployments.length})` });
  if (issues.length > 0) {
    // Most actionable first: a wrong registry, then "not built", then the rest.
    const order: DeployRefusal['code'][] = ['image_registry', 'invalid', 'image_not_built'];
    const code = order.find((k) => issues.some((i) => i.code === k)) ?? 'invalid';
    return { ok: false, code, reason: issues.filter((i) => i.code === code).map((i) => i.reason).join(' ') };
  }
  const image = String(podContainers(deployments[0])[0]?.image ?? '');
  return { ok: true, objects, image };
}

/**
 * The receive-gate / push validator for one `apps/<slug>/k8s/*.yaml` file: the same rules, minus
 * the host (the gate has no app record) and minus "not built" (committing the scaffold is fine).
 * Returns null when acceptable, else a sentence naming what is wrong.
 */
export function validateAppDeployFile(file: File, registry: string): string | null {
  const m = /^apps\/([a-z0-9][a-z0-9-]*)\//.exec(file.path);
  if (!m) return null;
  const parsed = parseDocs(file);
  if ('error' in parsed) return parsed.error;
  const issues = parsed.docs.flatMap((d) => objectIssues(d, file.path, m[1], registry)).filter((i) => i.code !== 'image_not_built');
  return issues.length ? issues.map((i) => i.reason).join(' ') : null;
}
