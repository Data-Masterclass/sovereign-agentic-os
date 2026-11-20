/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-54 — an app's build and deploy code is NATIVE: a Dockerfile, plain Kubernetes manifests under
 * `k8s/` and a CI workflow, committed in the app's tree. The OS deploys THOSE files; it does not
 * generate objects of its own. These tests pin the OS-side rules (which kinds, which names, which
 * registry, digest only). Kubernetes' own schema and Pod Security admission are checked by the API
 * server (dry-run), not here — see app-eject.kind.test.ts for that real-cluster proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import {
  APP_K8S_DIR,
  APP_CI_WORKFLOW,
  NOT_BUILT_DIGEST,
  appDeployFiles,
  planAppDeploy,
  validateAppDeployFile,
  isAppDeployPath,
  type DeployContext,
} from './native-deploy.ts';

const REGISTRY = 'registry.example.org/sovereign-os-apps';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ctx: DeployContext = {
  slug: 'color-picker',
  host: 'color-picker.sales.apps.example.org',
  registry: REGISTRY,
  ingressClass: 'nginx',
  tlsIssuer: 'letsencrypt',
  priorityClassName: 'user-apps',
};

function files(digest = DIGEST) {
  return appDeployFiles({ ...ctx, digest });
}

function edit(path: string, fn: (doc: Record<string, any>) => void, digest = DIGEST) {
  return files(digest).map((f) => {
    if (f.path !== path) return f;
    const doc = yaml.load(f.content) as Record<string, any>;
    fn(doc);
    return { path: f.path, content: yaml.dump(doc) };
  });
}

test('the scaffold writes native deploy code: Dockerfile-side k8s/ manifests + a CI workflow', () => {
  const paths = files().map((f) => f.path).sort();
  assert.deepEqual(paths, [APP_CI_WORKFLOW, `${APP_K8S_DIR}/deployment.yaml`, `${APP_K8S_DIR}/ingress.yaml`, `${APP_K8S_DIR}/service.yaml`].sort());
  for (const f of files()) {
    if (!f.path.startsWith(`${APP_K8S_DIR}/`)) continue;
    const doc = yaml.load(f.content) as Record<string, any>;
    assert.equal(doc.metadata.namespace, undefined, `${f.path}: no namespace (apply -n decides)`);
    assert.equal(doc.metadata.name, 'app-color-picker');
  }
});

test('the scaffolded Deployment meets Pod Security "restricted" and pins the image by digest', () => {
  const dep = yaml.load(files().find((f) => f.path === `${APP_K8S_DIR}/deployment.yaml`)!.content) as Record<string, any>;
  const pod = dep.spec.template.spec;
  const c = pod.containers[0];
  assert.equal(c.image, `${REGISTRY}/color-picker@${DIGEST}`);
  assert.equal(c.imagePullPolicy, 'IfNotPresent');
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.priorityClassName, 'user-apps');
  assert.deepEqual(c.volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }], 'temp files on an in-memory /tmp');
  assert.ok(c.resources.requests.cpu && c.resources.requests.memory && c.resources.limits.memory);
});

test('the CI workflow builds the Dockerfile and pushes to the platform registry, reporting the digest', () => {
  const wf = yaml.load(files().find((f) => f.path === APP_CI_WORKFLOW)!.content) as Record<string, any>;
  const steps = wf.jobs.image.steps as Record<string, any>[];
  const build = steps.find((s) => String(s.uses ?? '').startsWith('docker/build-push-action@'));
  assert.ok(build, 'uses docker/build-push-action');
  assert.equal(build!.with.push, true);
  assert.equal(wf.env.IMAGE, `${REGISTRY}/color-picker`);
  for (const s of steps) if (s.uses) assert.match(String(s.uses), /@[0-9a-f]{40}$/, `${s.uses} pinned by sha`);
});

test('planAppDeploy returns exactly the committed objects, unchanged', () => {
  const plan = planAppDeploy(files(), ctx);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.objects.map((o) => `${o.kind}/${(o.metadata as any).name}`).sort(), [
    'Deployment/app-color-picker',
    'Ingress/app-color-picker',
    'Service/app-color-picker',
  ]);
  const committed = yaml.load(files().find((f) => f.path === `${APP_K8S_DIR}/deployment.yaml`)!.content);
  assert.deepEqual(plan.objects.find((o) => o.kind === 'Deployment'), committed);
  assert.equal(plan.image, `${REGISTRY}/color-picker@${DIGEST}`);
});

// ------------------------------------------------------------------ refusals ---

function refused(fs: { path: string; content: string }[], code: string, re?: RegExp, c: DeployContext = ctx) {
  const plan = planAppDeploy(fs, c);
  assert.equal(plan.ok, false, `expected refusal ${code}`);
  if (plan.ok) return;
  assert.equal(plan.code, code, plan.reason);
  if (re) assert.match(plan.reason, re);
}

test('NO manifests committed → refused; the OS never generates objects of its own', () => {
  refused([{ path: 'Dockerfile', content: 'FROM scratch\n' }], 'no_manifests', /k8s\//);
});

test('an image on a registry the platform does not own is refused (the lost-registry failure)', () => {
  refused(
    edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => {
      d.spec.template.spec.containers[0].image = 'forgejo-http:3000/gitea_admin/color-picker:latest';
    }),
    'image_registry',
    /registry\.example\.org\/sovereign-os-apps\/color-picker/,
  );
});

test('a mutable tag on the right registry is refused — digest only', () => {
  refused(
    edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => {
      d.spec.template.spec.containers[0].image = `${REGISTRY}/color-picker:latest`;
    }),
    'image_registry',
    /digest/,
  );
});

test('another app\'s repository on the platform registry is refused', () => {
  refused(
    edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => {
      d.spec.template.spec.containers[0].image = `${REGISTRY}/someone-else@${DIGEST}`;
    }),
    'image_registry',
  );
});

test('the not-built placeholder digest is refused with "build the image first"', () => {
  refused(files(NOT_BUILT_DIGEST), 'image_not_built', /CI workflow|docker build/);
});

test('no platform registry configured → refused (fail closed, no default registry)', () => {
  refused(files(), 'no_registry', /imageRegistry/, { ...ctx, registry: '' });
});

test('a NetworkPolicy, Role or any other kind is refused: isolation is the platform\'s', () => {
  const np = { path: `${APP_K8S_DIR}/np.yaml`, content: yaml.dump({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'app-color-picker' }, spec: { podSelector: {}, egress: [{}] } }) };
  refused([...files(), np], 'invalid', /NetworkPolicy/);
});

test('a namespace in a manifest is refused', () => {
  refused(edit(`${APP_K8S_DIR}/service.yaml`, (d) => { d.metadata.namespace = 'agentic-os'; }), 'invalid', /namespace/);
});

test('an object not named after the app is refused (one object set per app)', () => {
  refused(edit(`${APP_K8S_DIR}/service.yaml`, (d) => { d.metadata.name = 'os-ui'; }), 'invalid', /app-color-picker/);
});

test('an Ingress claiming another host is refused', () => {
  refused(
    edit(`${APP_K8S_DIR}/ingress.yaml`, (d) => { d.spec.rules[0].host = 'os.example.org'; }),
    'invalid',
    /host/,
  );
});

test('a container without resources is refused (C1 fixture)', () => {
  refused(edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => { delete d.spec.template.spec.containers[0].resources; }), 'invalid', /resources/);
});

test('a ServiceAccount other than default is refused', () => {
  refused(edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => { d.spec.template.spec.serviceAccountName = 'os-ui'; }), 'invalid', /serviceAccountName/);
});

test('YAML that does not parse is refused with the file name', () => {
  refused([...files(), { path: `${APP_K8S_DIR}/bad.yaml`, content: 'a: [' }], 'invalid', /bad\.yaml/);
});

// --------------------------------------------------------------- receive gate ---

test('isAppDeployPath matches apps/<slug>/k8s/*.yaml only', () => {
  assert.equal(isAppDeployPath('apps/color-picker/k8s/deployment.yaml'), true);
  assert.equal(isAppDeployPath('apps/color-picker/k8s/sub/x.yml'), true);
  assert.equal(isAppDeployPath('apps/color-picker/src/k8s.ts'), false);
  assert.equal(isAppDeployPath('models/gold/x.sql'), false);
});

test('the receive validator accepts the scaffold and the not-built placeholder, refuses a foreign registry', () => {
  for (const f of files(NOT_BUILT_DIGEST)) {
    if (!f.path.startsWith(`${APP_K8S_DIR}/`)) continue;
    assert.equal(validateAppDeployFile({ path: `apps/color-picker/${f.path}`, content: f.content }, REGISTRY), null, f.path);
  }
  const bad = edit(`${APP_K8S_DIR}/deployment.yaml`, (d) => {
    d.spec.template.spec.containers[0].image = 'forgejo-http:3000/gitea_admin/color-picker:latest';
  }).find((f) => f.path === `${APP_K8S_DIR}/deployment.yaml`)!;
  assert.match(validateAppDeployFile({ path: `apps/color-picker/${bad.path}`, content: bad.content }, REGISTRY) ?? '', /registry/);
});
