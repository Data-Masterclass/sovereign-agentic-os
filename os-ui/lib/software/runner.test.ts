/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runnerName,
  appImageRef,
  runnerSpec,
  buildDeploymentManifest,
  buildServiceManifest,
  buildIngressManifest,
  deployApp,
  runnerStatus,
  stopApp,
  deleteApp,
  type RunnerApp,
  type RunnerK8s,
} from './runner.ts';

const OPTS = { namespace: 'agentic-apps', ingressClass: 'nginx', tlsIssuer: 'letsencrypt-prod' };

const APP: RunnerApp = {
  slug: 'shop',
  host: 'shop.ops.apps.example.com',
  footprint: { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
};

const NS = OPTS.namespace;
const DEP = `/apis/apps/v1/namespaces/${NS}/deployments`;
const SVC = `/api/v1/namespaces/${NS}/services`;
const ING = `/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`;

/** A recording mock k8s client driven by a per-`METHOD path` table (+ method fallback). */
function mockK8s(responses: Record<string, { status: number; body?: Record<string, unknown> }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: RunnerK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responses[`${method} ${path}`] ?? responses[method] ?? { status: 0, body: {} };
    return { status: r.status, body: r.body ?? {} };
  };
  return { client, calls };
}

// --------------------------------------------------------------- Naming --------

test('runnerName is deterministic + RFC1123-safe', () => {
  assert.equal(runnerName('shop'), 'app-shop');
  assert.equal(runnerName('My_Cool App'), 'app-my-cool-app');
  assert.equal(runnerName('shop'), runnerName('shop'));
  assert.match(runnerName('shop'), /^[a-z0-9-]+$/);
});

test('appImageRef: explicit runImage wins; else the registry convention', () => {
  assert.equal(appImageRef({ slug: 'shop', runImage: 'ghcr.io/acme/shop:v2' }), 'ghcr.io/acme/shop:v2');
  // No explicit image + no SOFTWARE_RUNNER_IMAGE env → the CI registry convention.
  assert.match(appImageRef({ slug: 'shop' }), /\/shop:latest$/);
});

// ------------------------------------------------------------- Manifests -------

test('deployment manifest: 1 replica, requests+limits, TCP readiness probe, image', () => {
  const spec = runnerSpec(APP);
  const m = buildDeploymentManifest(spec, NS) as any;
  assert.equal(m.kind, 'Deployment');
  assert.equal(m.metadata.namespace, NS);
  assert.equal(m.spec.replicas, 1);
  const c = m.spec.template.spec.containers[0];
  assert.match(c.image, /\/shop:latest$/);
  assert.deepEqual(c.resources.requests, { cpu: '250m', memory: '256Mi' });
  assert.equal(c.resources.limits.memory, '256Mi'); // limit >= request
  assert.ok(c.readinessProbe.tcpSocket, 'has a TCP readiness probe (image-agnostic)');
  assert.equal(c.ports[0].containerPort, 8080);
  assert.equal(m.metadata.labels['app.kubernetes.io/managed-by'], 'os-ui');
});

test('service manifest: port 80 → targetPort 8080, selects the deployment pods', () => {
  const m = buildServiceManifest(runnerSpec(APP), NS) as any;
  assert.equal(m.spec.ports[0].port, 80);
  assert.equal(m.spec.ports[0].targetPort, 8080);
  assert.deepEqual(m.spec.selector, { app: 'app-shop' });
});

test('ingress manifest: per-app host, TLS secret, class + cluster-issuer match the chart', () => {
  const m = buildIngressManifest(runnerSpec(APP), NS, OPTS) as any;
  assert.equal(m.spec.rules[0].host, 'shop.ops.apps.example.com');
  assert.equal(m.spec.ingressClassName, 'nginx');
  assert.equal(m.spec.tls[0].secretName, 'shop.ops.apps.example.com-tls');
  assert.equal(m.metadata.annotations['cert-manager.io/cluster-issuer'], 'letsencrypt-prod');
  assert.equal(m.spec.rules[0].http.paths[0].backend.service.port.number, 80);
});

// --------------------------------------------------------------- Deploy --------

test('deployApp CREATES ns + Deployment + Service + Ingress when none exist', async () => {
  const { client, calls } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 404 },
    'POST /api/v1/namespaces': { status: 201 },
    GET: { status: 404 }, // every object GET → not found → POST-create
    POST: { status: 201 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.live, true);
  assert.equal(out.action, 'deployed');
  assert.equal(out.url, 'https://shop.ops.apps.example.com');
  // Not ready yet (final status GET → 404 → absent) → honest 'deploying', not 'running'.
  assert.equal(out.phase, 'deploying');
  // It POSTed a Deployment, a Service and an Ingress.
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === DEP));
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === SVC));
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === ING));
});

test('deployApp is idempotent — existing objects are REPLACED (PUT), reports running', async () => {
  const running = { status: 200, body: { spec: { replicas: 1 }, status: { readyReplicas: 1 }, metadata: { resourceVersion: '7' } } };
  const { client, calls } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    [`GET ${DEP}/app-shop`]: running,
    [`GET ${SVC}/app-shop`]: { status: 200, body: { metadata: { resourceVersion: '3' } } },
    [`GET ${ING}/app-shop`]: { status: 200, body: { metadata: { resourceVersion: '5' } } },
    PUT: { status: 200 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'deployed');
  assert.equal(out.phase, 'running');
  assert.equal(out.url, 'https://shop.ops.apps.example.com');
  const put = calls.find((c) => c.method === 'PUT' && c.path === `${DEP}/app-shop`)!;
  assert.equal((put.body as any).metadata.resourceVersion, '7', 'PUT carries the resourceVersion');
});

test('HONESTY: an unreachable API server never claims a live deploy (status 0)', async () => {
  const { client } = mockK8s({ GET: { status: 0 } });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.equal(out.url, null);
  assert.equal(out.phase, 'offline');
  assert.match(out.detail, /unreachable/i);
});

test('HONESTY: a cluster rejection surfaces as a non-ok, no URL', async () => {
  const { client } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    GET: { status: 404 },
    [`POST ${DEP}`]: { status: 422 },
    POST: { status: 201 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.url, null);
  assert.equal(out.phase, 'failed');
  assert.match(out.detail, /422/);
});

// --------------------------------------------------------------- Status --------

test('runnerStatus maps real Deployment state to a pod-driven phase', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ spec: { replicas: 1 }, status: { readyReplicas: 1 } }, 'running'],
    [{ spec: { replicas: 1 }, status: { readyReplicas: 0 } }, 'deploying'],
    [{ spec: { replicas: 0 }, status: {} }, 'stopped'],
    [
      { spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }] } },
      'failed',
    ],
  ];
  for (const [body, phase] of cases) {
    const { client } = mockK8s({ [`GET ${DEP}/app-shop`]: { status: 200, body } });
    const st = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: client });
    assert.equal(st.phase, phase, `expected ${phase}`);
    assert.equal(st.live, true);
  }
});

test('runnerStatus: 404 → absent, status 0 → offline (honest)', async () => {
  const absent = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ GET: { status: 404 } }).client });
  assert.equal(absent.phase, 'absent');
  const offline = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ GET: { status: 0 } }).client });
  assert.equal(offline.phase, 'offline');
  assert.equal(offline.live, false);
});

// ------------------------------------------------------------- Stop / delete ---

test('stopApp scales the Deployment to zero (PATCH /scale)', async () => {
  const { client, calls } = mockK8s({ PATCH: { status: 200 } });
  const out = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'stopped');
  assert.equal(out.phase, 'stopped');
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.path, `${DEP}/app-shop/scale`);
  assert.deepEqual((patch.body as any).spec, { replicas: 0 });
});

test('stopApp: 404 is a benign no-op; status 0 is honest offline', async () => {
  const missing = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ PATCH: { status: 404 } }).client });
  assert.equal(missing.ok, true);
  assert.equal(missing.phase, 'absent');
  const offline = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ PATCH: { status: 0 } }).client });
  assert.equal(offline.ok, false);
  assert.equal(offline.live, false);
  assert.match(offline.detail, /unreachable/i);
});

test('deleteApp removes Ingress + Service + Deployment (404s benign)', async () => {
  const { client, calls } = mockK8s({
    [`DELETE ${ING}/app-shop`]: { status: 200 },
    [`DELETE ${SVC}/app-shop`]: { status: 200 },
    [`DELETE ${DEP}/app-shop`]: { status: 404 }, // already gone → still ok
  });
  const out = await deleteApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'deleted');
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  assert.deepEqual(deletes.sort(), [`${DEP}/app-shop`, `${ING}/app-shop`, `${SVC}/app-shop`].sort());
});

test('HONESTY: deleteApp with an unreachable API never claims success', async () => {
  const { client } = mockK8s({ DELETE: { status: 0 } });
  const out = await deleteApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.match(out.detail, /unreachable/i);
});
