/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the annotation allow-list for app Ingresses.
 * USER STORY: As an operator I want proof that the runner never writes an app Ingress with an
 *             annotation or class outside the allow-list.
 * ARCHITECTURE:
 *   - Pure function tests of app-ingress-policy.ts, plus deployApp with a recording k8s client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_INGRESS_ANNOTATION_ALLOWLIST, appIngressViolations } from './app-ingress-policy.ts';
import { buildIngressManifest, deployApp, runnerSpec, type RunnerApp, type RunnerK8s } from './runner.ts';

const NS = 'agentic-apps';
const OPTS = { namespace: NS, ingressClass: 'nginx', tlsIssuer: 'letsencrypt-prod' };
const ING = `/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`;
const APP: RunnerApp = {
  slug: 'shop',
  host: 'shop.ops.apps.example.com',
  runImage: 'registry.example.com/apps/shop@sha256:' + 'a'.repeat(64),
  footprint: { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
};
const ingress = (annotations: Record<string, string> | undefined, ingressClassName?: string) => ({
  metadata: { name: 'app-x', ...(annotations ? { annotations } : {}) },
  spec: { ...(ingressClassName === undefined ? {} : { ingressClassName }) },
});

test('the allow-list is exactly the TLS issuer annotation the runner sets', () => {
  assert.deepEqual([...APP_INGRESS_ANNOTATION_ALLOWLIST], ['cert-manager.io/cluster-issuer']);
});

test("the runner's own Ingress passes", () => {
  assert.deepEqual(appIngressViolations(buildIngressManifest(runnerSpec(APP), NS, OPTS), 'nginx'), []);
  assert.deepEqual(appIngressViolations(ingress(undefined, 'nginx'), 'nginx'), []);
});

test('an annotation outside the allow-list is refused, by name', () => {
  for (const key of [
    'nginx.ingress.kubernetes.io/auth-url',
    'nginx.ingress.kubernetes.io/configuration-snippet',
    'nginx.ingress.kubernetes.io/server-snippet',
    'kubernetes.io/ingress.class',
  ]) {
    const v = appIngressViolations(ingress({ 'cert-manager.io/cluster-issuer': 'x', [key]: 'v' }, 'nginx'), 'nginx');
    assert.equal(v.length, 1, key);
    assert.match(v[0], new RegExp(key.replace(/[./]/g, '\\$&')));
  }
});

test('another class, no class, or no configured class is refused', () => {
  assert.match(appIngressViolations(ingress(undefined, 'other'), 'nginx')[0], /must be 'nginx' \(got 'other'\)/);
  assert.match(appIngressViolations(ingress(undefined), 'nginx')[0], /got none/);
  assert.match(appIngressViolations(ingress(undefined, ''), '')[0], /no ingress class is configured/);
});

test('deployApp refuses an Ingress that fails the allow-list and never writes it', async () => {
  const calls: { method: string; path: string }[] = [];
  const k8s: RunnerK8s = async (method, path) => {
    calls.push({ method, path });
    if (method === 'GET' && path === `/api/v1/namespaces/${NS}`) return { status: 200, body: {} };
    if (method === 'GET') return { status: 404, body: {} };
    return { status: 201, body: {} };
  };
  const out = await deployApp(APP, { ...OPTS, ingressClass: '', k8s });
  assert.equal(out.ok, false);
  assert.equal(out.phase, 'failed');
  assert.equal(out.url, null);
  assert.match(out.detail, /no ingress class is configured/);
  assert.equal(calls.filter((c) => c.path.startsWith(ING)).length, 0, 'no Ingress read or write');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'nothing written: the check runs before any object');
});
