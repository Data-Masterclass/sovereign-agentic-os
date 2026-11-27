/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE: tests for the Zot adapter (core/adapters/zot/client.ts, App Builder C1).
 * USER STORY: as an operator I want proof that the same slug in two domains never shares a repository, a push user or a
 *   push Secret, that a domain's credential is created once and never read back, and that a digest check names failures.
 * ARCHITECTURE: names are pure; Kubernetes is a recorded fake of the API's own answers; the registry is a real local HTTP
 *   server answering the OCI distribution HEAD (no fetch mock).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { digestExists, domainKey, ensurePushCredential, imageRepository, pushSecretManifest, pushSecretName, pushUserName, type ZotK8s } from './client.ts';

test('the same slug in two domains: disjoint repository, push user and push Secret', () => {
  const a = { repo: imageRepository('sales', 'shop'), user: pushUserName('sales'), secret: pushSecretName('sales') };
  const b = { repo: imageRepository('hr', 'shop'), user: pushUserName('hr'), secret: pushSecretName('hr') };
  assert.notEqual(a.repo, b.repo); assert.notEqual(a.user, b.user); assert.notEqual(a.secret, b.secret);
  assert.match(a.repo, /^apps\/sales-[0-9a-f]{8}\/shop$/);
  // domains that sanitise to the same text still differ by the hash
  assert.notEqual(domainKey('a.b'), domainKey('a-b'));
  assert.notEqual(domainKey('Sales'), domainKey('sales'));
});

test('domainKey is a DNS label and matches the listener grammar; the Secret is bound to the repository', () => {
  for (const d of ['sales', 'A_very.Long-domain_name_with.many.dots.and_more_and_more_and_more', '---', 'ünï']) {
    const k = domainKey(d);
    assert.match(k, /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/, k);
    const repo = imageRepository(d, 'app-1');
    assert.match(repo, /^apps\/[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
    // the CEL rule in software-tekton.yaml: pushSecret == 'zot-push-' + imageRepo.split('/')[1]
    assert.equal(pushSecretName(d), `zot-push-${repo.split('/')[1]}`);
  }
  assert.throws(() => imageRepository('sales', 'Bad_Slug'));
  assert.throws(() => imageRepository('sales', '-x'));
  assert.throws(() => domainKey(''));
});

test('the push Secret: labels for zot-users, repository annotation, dockerconfigjson for the in-cluster registry', () => {
  const m = pushSecretManifest('sales', 'pw-0123456789abcdef01234567', 'zot.agentic-os.svc.cluster.local:5000', 'agentic-build') as {
    metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> }; data: Record<string, string>;
  };
  assert.equal(m.metadata.labels['soa.dev/zot-push'], 'true');
  assert.equal(m.metadata.annotations['soa.dev/zot-repository'], `apps/${domainKey('sales')}`);
  const dec = (s: string) => Buffer.from(s, 'base64').toString('utf8');
  assert.equal(dec(m.data.username), pushUserName('sales'));
  const dcj = JSON.parse(dec(m.data['.dockerconfigjson'])) as { auths: Record<string, { auth: string }> };
  assert.equal(dec(dcj.auths['zot.agentic-os.svc.cluster.local:5000'].auth), `${pushUserName('sales')}:pw-0123456789abcdef01234567`);
});

function fakeK8s(answers: Record<string, { status: number; body?: Record<string, unknown> }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const k8s: ZotK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    const a = answers[`${method} ${path}`] ?? { status: 500 };
    return { status: a.status, body: a.body ?? {} };
  };
  return { k8s, calls };
}
const deps = (k8s: ZotK8s) => ({ k8s, buildNamespace: 'agentic-build', platformNamespace: 'agentic-os', registryHost: 'zot.agentic-os.svc.cluster.local:5000', random: () => 'r'.repeat(48), now: () => new Date(0) });

test('ensurePushCredential: creates once, then starts the zot-users reconcile from the CronJob template', async () => {
  const name = pushSecretName('sales');
  const { k8s, calls } = fakeK8s({
    [`GET /api/v1/namespaces/agentic-build/secrets/${name}`]: { status: 404 },
    'POST /api/v1/namespaces/agentic-build/secrets': { status: 201 },
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/zot-users': { status: 200, body: { spec: { jobTemplate: { spec: { template: { spec: { containers: [] } } } } } } },
    'POST /apis/batch/v1/namespaces/agentic-os/jobs': { status: 201 },
  });
  const r = await ensurePushCredential('sales', deps(k8s));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.value, { created: true, secret: name, reconcileJob: 'zot-users-0' });
  const job = calls.find((c) => c.path.endsWith('/jobs'))?.body as { spec: unknown };
  assert.deepEqual(job.spec, { template: { spec: { containers: [] } } });
  // nothing reads the password back: no GET returns data to the caller
  assert.ok(!JSON.stringify(r).includes('r'.repeat(48)));
});

test('ensurePushCredential: an existing Secret (or a parallel create, 409) is left alone; other answers are named', async () => {
  const name = pushSecretName('sales');
  const exists = fakeK8s({ [`GET /api/v1/namespaces/agentic-build/secrets/${name}`]: { status: 200 } });
  const r1 = await ensurePushCredential('sales', deps(exists.k8s));
  assert.ok(r1.ok && !r1.value.created);
  assert.equal(exists.calls.length, 1);
  const race = fakeK8s({ [`GET /api/v1/namespaces/agentic-build/secrets/${name}`]: { status: 404 }, 'POST /api/v1/namespaces/agentic-build/secrets': { status: 409 } });
  const r2 = await ensurePushCredential('sales', deps(race.k8s));
  assert.ok(r2.ok && !r2.value.created);
  const denied = fakeK8s({ [`GET /api/v1/namespaces/agentic-build/secrets/${name}`]: { status: 403 } });
  const r3 = await ensurePushCredential('sales', deps(denied.k8s));
  assert.ok(!r3.ok && r3.reason === 'forbidden');
  const noCron = fakeK8s({ [`GET /api/v1/namespaces/agentic-build/secrets/${name}`]: { status: 404 }, 'POST /api/v1/namespaces/agentic-build/secrets': { status: 201 }, 'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/zot-users': { status: 404 } });
  const r4 = await ensurePushCredential('sales', deps(noCron.k8s));
  assert.ok(!r4.ok && r4.reason === 'not_found');
  const unconfigured = await ensurePushCredential('sales', { ...deps(exists.k8s), registryHost: '' });
  assert.ok(!unconfigured.ok && unconfigured.reason === 'invalid');
});

const seen: IncomingMessage[] = [];
const server = createServer((req, res) => {
  seen.push(req);
  if (req.headers.authorization !== `Basic ${Buffer.from('pull:pw').toString('base64')}`) { res.writeHead(401).end(); return; }
  res.writeHead(req.url?.endsWith('a'.repeat(64)) ? 200 : 404).end();
});
after(() => server.close());
const repo = imageRepository('sales', 'shop');

test('digestExists: 200 = true, 404 = false, 401 named, bad input refused before any request', async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = async () => Buffer.from('pull:pw').toString('base64');
  const yes = await digestExists(repo, `sha256:${'a'.repeat(64)}`, { fetch, registryHost: host, pullAuth: auth });
  assert.ok(yes.ok && yes.value === true);
  assert.equal(seen.at(-1)?.method, 'HEAD');
  const no = await digestExists(repo, `sha256:${'b'.repeat(64)}`, { fetch, registryHost: host, pullAuth: auth });
  assert.ok(no.ok && no.value === false);
  const wrong = await digestExists(repo, `sha256:${'a'.repeat(64)}`, { fetch, registryHost: host, pullAuth: async () => Buffer.from('pull:nope').toString('base64') });
  assert.ok(!wrong.ok && wrong.reason === 'unauthorized');
  const n = seen.length;
  const bad = await digestExists('library/node', 'latest', { fetch, registryHost: host, pullAuth: auth });
  assert.ok(!bad.ok && bad.reason === 'invalid');
  assert.equal(seen.length, n);
  const noAuth = await digestExists(repo, `sha256:${'a'.repeat(64)}`, { fetch, registryHost: host, pullAuth: async () => null });
  assert.ok(!noAuth.ok && noAuth.reason === 'unauthorized');
});
