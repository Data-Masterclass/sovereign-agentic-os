/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - the pure parts of releases: names, overlay, records, slots, rollback plan, auto-dev,
 *             redaction, needs-rebuild marking, the Prod gate and the deploy gate's v2 rules
 * USER STORY: As the owner I want every rule of the release flow pinned by a test that runs without a cluster.
 * ARCHITECTURE: node:test, no I/O except the fake Kubernetes clients injected into logs/needs-rebuild.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import type { App } from '@tabs/software/lib/apps';
import { appResourceName, type AppRelease } from '@tabs/software/lib/app-builder-contracts';
import type { CheckRecord } from '@tabs/software/lib/check-record';
import { REQUIRED_GATES } from '@tabs/software/lib/gates';
import { appDeployFiles, planAppDeploy, validateAppDeployFile, appObjectName } from '@tabs/software/lib/native-deploy';
import { imageRepository, releasePins, RELEASE_PINS_ANNOTATION } from '@core/adapters/zot/client';
import { appEnvHost, applyEnvOverlay, applyPreviewOverlay, changedPaths } from './overlay.ts';
import { canTransition, transition, withRelease, releaseTag, currentRelease, rollbackTarget, RELEASE_KEEP, newReleaseId, releaseFileContent } from './store.ts';
import { chooseSlot, slotIdle, PREVIEW_IDLE_MS } from './previews.ts';
import { rollbackPlan, ROLLBACK_WARNING } from './rollback.ts';
import { autoDevDecision } from './auto-dev.ts';
import { redactLogs, readAppLogs, REDACTED } from './logs.ts';
import { legacyRegistryReason, markNeedsRebuild, runAppMigration } from './needs-rebuild.ts';
import { consequenceSentences, pendingProdMigrations } from './consequences.ts';
import { prodGateRefusal, unreviewedGoLiveBlock } from '@tabs/software/lib/review';
import { recordFromRun, parseCriteria } from '@tabs/software/lib/tekton-record';
import { appCallbackHosts } from '../../../../app-token-sources.ts';

const flag = (on: boolean) => {
  process.env.SOFTWARE_APP_BUILDER = on ? 'on' : 'off';
};
afterEach(() => {
  delete process.env.SOFTWARE_APP_BUILDER;
});

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const D3 = `sha256:${'3'.repeat(64)}`;
const SHA = (c: string) => c.repeat(40).slice(0, 40);
const rel = (p: Partial<AppRelease> & Pick<AppRelease, 'id' | 'env' | 'at'>): AppRelease => ({ slug: 'orders', sha: SHA('a'), digest: D1, by: 'alice', previous: null, migrations: { applied: [], status: 'none' }, state: 'running', ...p });
const CTX = { slug: 'orders', registry: 'zot.platform.svc:5000', ingressClass: 'nginx', tlsIssuer: 'letsencrypt' };

// ---------------------------------------------------------------- names, hosts, overlay ----

test('same slug in two domains: every object, slot, host and image repository is disjoint', () => {
  const names = (d: string) => [appResourceName(d, 'orders'), appResourceName(d, 'orders', 'p1'), appResourceName(d, 'orders', 'p2'), appEnvHost(d, 'orders', 'dev', 'apps.example'), appEnvHost(d, 'orders', 'prod', 'apps.example'), appEnvHost(d, 'orders', 'dev', 'apps.example', 'p1'), imageRepository(d, 'orders')];
  const a = names('sales');
  const b = names('hr');
  for (const x of a) assert.ok(!b.includes(x), `${x} is shared by two domains`);
  assert.equal(appEnvHost('sales', 'orders', 'dev', 'apps.example'), 'orders.sales.dev.apps.example');
  assert.equal(appEnvHost('sales', 'orders', 'prod', 'apps.example'), 'orders.sales.apps.example');
  assert.equal(appEnvHost('sales', 'orders', 'dev', 'apps.example', 'p2'), 'orders--p2.sales.dev.apps.example');
  assert.equal(appEnvHost('Sales_EU', 'orders', 'dev', 'apps.example'), null, 'a domain id that is not a DNS label has no host');
  assert.equal(appEnvHost('sales', 'orders', 'prod', 'apps.example', 'p1'), null, 'no preview slot in Prod');
});

test('release hosts are exactly the registered app sign-in callback hosts (one rule, E and C2)', () => {
  for (const slug of ['orders', 'x'.repeat(62)]) {
    const cb = appCallbackHosts('sales', slug, 'apps.example')!;
    assert.deepEqual(cb.prod, [appEnvHost('sales', slug, 'prod', 'apps.example')]);
    assert.deepEqual(cb.dev, [appEnvHost('sales', slug, 'dev', 'apps.example'), appEnvHost('sales', slug, 'dev', 'apps.example', 'p1'), appEnvHost('sales', slug, 'dev', 'apps.example', 'p2')]);
  }
});

const v2Objects = (domain = 'sales') => {
  const files = appDeployFiles({ ...CTX, host: appEnvHost(domain, 'orders', 'prod', 'apps.example')!, domain, templateVersion: 2 });
  const plan = planAppDeploy(files, { ...CTX, host: appEnvHost(domain, 'orders', 'prod', 'apps.example')!, domain, templateVersion: 2 }, { allowUnbuilt: true });
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  return plan.ok ? plan.objects : [];
};

test('the env overlay changes EXACTLY namespace, the container image and the Ingress host + TLS secret', () => {
  const objs = v2Objects();
  const image = `zot.example/${imageRepository('sales', 'orders')}@${D1}`;
  const host = 'orders.sales.dev.apps.example';
  const out = applyEnvOverlay(objs, { namespace: 'apps-dev', image, host });
  const changed = objs.flatMap((o, i) => changedPaths(o, out[i]).map((p) => `${String(o.kind)}:${p}`)).sort();
  assert.deepEqual(changed, [
    'Deployment:metadata.namespace',
    'Deployment:spec.template.spec.containers[0].image',
    'Ingress:metadata.namespace',
    'Ingress:spec.rules[0].host',
    'Ingress:spec.tls[0].hosts[0]',
    'Ingress:spec.tls[0].secretName',
    'Service:metadata.namespace',
  ]);
  assert.equal((out.find((o) => o.kind === 'Ingress')!.spec as { tls: { secretName: string }[] }).tls[0].secretName, `${host}-tls`);
  assert.deepEqual(objs, v2Objects(), 'the committed objects are not mutated');
});

test('a preview slot runs under its own names and host, with the same image; another domain gets other names', () => {
  const out = applyPreviewOverlay(v2Objects(), { namespace: 'apps-dev', image: 'x/apps/k/orders@' + D1, host: 'orders--p1.sales.dev.apps.example', domain: 'sales', slug: 'orders', slot: 'p1' });
  const slot = appResourceName('sales', 'orders', 'p1');
  for (const o of out) assert.equal((o.metadata as { name: string }).name, slot);
  const dep = out.find((o) => o.kind === 'Deployment')!;
  assert.deepEqual((dep.spec as { selector: unknown }).selector, { matchLabels: { 'app.kubernetes.io/name': slot } });
  const ing = out.find((o) => o.kind === 'Ingress')!;
  assert.equal((ing.spec as { rules: { http: { paths: { backend: { service: { name: string } } }[] } }[] }).rules[0].http.paths[0].backend.service.name, slot);
  const other = applyPreviewOverlay(v2Objects('hr'), { namespace: 'apps-dev', image: 'x', host: 'orders--p1.hr.dev.apps.example', domain: 'hr', slug: 'orders', slot: 'p1' });
  assert.notEqual((other[0].metadata as { name: string }).name, slot);
});

// ---------------------------------------------------------------- the deploy gate, v2 ----

test('deploy gate (v2): names are appResourceName; an image of ANOTHER domain\'s repository is refused, the own one passes', () => {
  const host = appEnvHost('sales', 'orders', 'prod', 'apps.example')!;
  const ctx = { ...CTX, host, domain: 'sales', templateVersion: 2 as const };
  const files = appDeployFiles({ ...ctx, digest: D1 });
  assert.equal(appObjectName(ctx), appResourceName('sales', 'orders'));
  assert.equal(planAppDeploy(files, ctx).ok, true);
  const foreign = files.map((f) => (f.path.endsWith('deployment.yaml') ? { ...f, content: f.content.split(imageRepository('sales', 'orders')).join(imageRepository('hr', 'orders')) } : f));
  const p = planAppDeploy(foreign, ctx);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.code, 'image_registry');
  // v1 names are refused for a v2 app, and a v2 app's names for a v1 app
  const v1files = appDeployFiles({ ...CTX, host: 'orders.sales.apps.example', digest: D1 });
  assert.equal(planAppDeploy(v1files, ctx).ok, false);
  assert.equal(planAppDeploy(files, { ...CTX, host }).ok, false);
});

test('deploy gate (v2): the pod verifies the database TLS against the CA-only ConfigMap; v1 manifests are unchanged', () => {
  const ctx = { ...CTX, host: 'orders.sales.apps.example', domain: 'sales', templateVersion: 2 as const };
  const dep = yaml.load(appDeployFiles(ctx).find((f) => f.path.endsWith('deployment.yaml'))!.content.split('\n').slice(1).join('\n')) as { spec: { template: { spec: { volumes: Record<string, unknown>[]; containers: { env: { name: string; value?: string }[]; volumeMounts: { name: string; readOnly?: boolean }[] }[] } } } };
  const pod = dep.spec.template.spec;
  const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value]));
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGREQUIREAUTH, 'scram-sha-256');
  assert.equal(env.PGSSLROOTCERT, '/etc/soa/pg-ca/ca.crt');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/soa/pg-ca/ca.crt');
  const vol = pod.volumes.find((v) => v.name === 'pg-ca') as { configMap: { name: string; items: unknown[] } };
  assert.equal(vol.configMap.name, 'apps-pg-ca-cert', 'a ConfigMap with the CA certificate only, never the CNPG CA Secret (it holds the key)');
  assert.deepEqual(vol.configMap.items, [{ key: 'ca.crt', path: 'ca.crt' }]);
  assert.equal(pod.containers[0].volumeMounts.find((m) => m.name === 'pg-ca')?.readOnly, true);
  assert.equal(planAppDeploy(appDeployFiles(ctx), ctx, { allowUnbuilt: true }).ok, true, 'the gate accepts the CA volume');
  const v1 = appDeployFiles({ ...CTX, host: 'orders.sales.apps.example' }).find((f) => f.path.endsWith('deployment.yaml'))!.content;
  assert.doesNotMatch(v1, /pg-ca|verify-full/);
});

test('receive/push validator (v2): valid for one of the apps at the slug; another domain\'s Secret or repository is refused', () => {
  const ctx = { ...CTX, host: 'orders.sales.apps.example', domain: 'sales', templateVersion: 2 as const };
  const dep = appDeployFiles({ ...ctx, digest: D1 }).find((f) => f.path.endsWith('deployment.yaml'))!;
  const file = { path: 'apps/orders/k8s/deployment.yaml', content: dep.content };
  const targets = { targets: [{ domain: 'sales', templateVersion: 2 as const, registries: [CTX.registry] }] };
  assert.equal(validateAppDeployFile(file, '', targets), null);
  assert.equal(validateAppDeployFile(file, '', { targets: [{ domain: 'hr', templateVersion: 2 as const, registries: [CTX.registry] }, ...targets.targets] }), null, 'one matching app is enough');
  const otherSecret = { ...file, content: file.content.split(appResourceName('sales', 'orders', 'db')).join(appResourceName('hr', 'orders', 'db')) };
  assert.match(validateAppDeployFile(otherSecret, '', targets) ?? '', /only its own Secrets/);
  const otherRepo = { ...file, content: file.content.split(imageRepository('sales', 'orders')).join(imageRepository('hr', 'orders')) };
  assert.match(validateAppDeployFile(otherRepo, '', targets) ?? '', /not allowed/);
});

// ---------------------------------------------------------------- records ----

test('release state machine: deploying → running | failed, running → rolled-back, nothing else', () => {
  assert.ok(canTransition('deploying', 'running') && canTransition('deploying', 'failed') && canTransition('running', 'rolled-back'));
  for (const [a, b] of [['running', 'deploying'], ['failed', 'running'], ['rolled-back', 'running'], ['running', 'failed'], ['deploying', 'rolled-back']] as const) assert.equal(canTransition(a, b), false, `${a} → ${b}`);
  assert.throws(() => transition(rel({ id: 'r1', env: 'dev', at: '1', state: 'failed' }), 'running'), (e: Error & { status?: number }) => e.status === 409);
  assert.match(newReleaseId(new Date('2026-11-27T10:15:30Z'), () => 'ab12'), /^r20261127101530ab12$/);
  assert.equal(releaseTag('prod', 'r1'), 'release-prod-r1');
});

test('retention keeps the newest per env and slot, and always the current and previous release', () => {
  let list: AppRelease[] = [rel({ id: 'base', env: 'prod', at: '2026-01-01T00:00:00Z' })];
  for (let i = 0; i < RELEASE_KEEP + 5; i++) list = withRelease(list, rel({ id: `f${i}`, env: 'prod', at: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`, state: 'failed', previous: 'base' }));
  assert.ok(list.some((r) => r.id === 'base'), 'the running release survives many failed ones');
  assert.equal(currentRelease({ releases: list }, 'prod')?.id, 'base');
  assert.ok(list.filter((r) => r.env === 'prod').length <= RELEASE_KEEP + 1);
});

test('release pins name exactly release-<env>-<id> → digest, for the platform keeper (never a push credential)', () => {
  assert.equal(RELEASE_PINS_ANNOTATION, 'soa.dev/release-tags');
  assert.deepEqual(releasePins([{ env: 'dev', id: 'r1', digest: D1 }, { env: 'dev', id: 'bad id', digest: D2 }, { env: 'prod', id: 'r2', digest: 'latest' }]), { 'release-dev-r1': D1 });
});

test('the committed release file holds records only (no credential)', () => {
  const txt = releaseFileContent({ id: 'app_1', slug: 'orders', domain: 'sales', releases: [rel({ id: 'r1', env: 'dev', at: '2026-11-27T00:00:00Z' })] });
  const doc = yaml.load(txt.split('\n').slice(1).join('\n')) as { releases: { id: string; digest: string }[] };
  assert.equal(doc.releases[0].id, 'r1');
  assert.doesNotMatch(txt, /password|token/i);
});

// ---------------------------------------------------------------- previews ----

test('preview slots: empty p1, then p2, then the slot with the OLDER release; the same sha reuses its slot', () => {
  const a: Pick<App, 'releases'> = { releases: [] };
  assert.equal(chooseSlot(a, SHA('a')), 'p1');
  a.releases = [rel({ id: 'p1a', env: 'dev', slot: 'p1', sha: SHA('a'), at: '2026-11-27T01:00:00Z' })];
  assert.equal(chooseSlot(a, SHA('b')), 'p2');
  assert.equal(chooseSlot(a, SHA('a')), 'p1');
  a.releases.push(rel({ id: 'p2b', env: 'dev', slot: 'p2', sha: SHA('b'), at: '2026-11-27T02:00:00Z' }));
  assert.equal(chooseSlot(a, SHA('c')), 'p1', 'p1 holds the older sha');
  a.releases.push(rel({ id: 'p1c', env: 'dev', slot: 'p1', sha: SHA('c'), at: '2026-11-27T03:00:00Z' }));
  assert.equal(chooseSlot(a, SHA('d')), 'p2');
});

test('a slot is idle after 8 h since its release or its last wake', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(PREVIEW_IDLE_MS, 8 * 3600 * 1000);
  assert.equal(slotIdle({ at: '2026-11-27T03:59:00Z' }, undefined, now), true);
  assert.equal(slotIdle({ at: '2026-11-27T04:01:00Z' }, undefined, now), false);
  assert.equal(slotIdle({ at: '2026-11-27T01:00:00Z' }, now - 60_000, now), false, 'a wake restarts the clock');
  assert.equal(slotIdle(null, undefined, now), false);
});

// ---------------------------------------------------------------- rollback ----

test('rollback plan: the previous digest, the migrations applied since, and the forward-only warning', () => {
  const app: Pick<App, 'releases'> = {
    releases: [
      rel({ id: 'r1', env: 'prod', at: '2026-11-25T00:00:00Z', digest: D1, migrations: { applied: ['0001_init'], status: 'ok' } }),
      rel({ id: 'r2', env: 'prod', at: '2026-11-26T00:00:00Z', digest: D2, migrations: { applied: ['0002_orders'], status: 'ok' }, previous: 'r1' }),
      rel({ id: 'r3', env: 'prod', at: '2026-11-27T00:00:00Z', digest: D3, migrations: { applied: ['0003_index'], status: 'ok' }, previous: 'r2' }),
    ],
  };
  const plan = rollbackPlan(app, 'prod')!;
  assert.equal(plan.current.id, 'r3');
  assert.equal(plan.target.id, 'r2');
  assert.deepEqual(plan.migrationsSince, ['0003_index']);
  assert.equal(plan.warning, ROLLBACK_WARNING);
  assert.match(plan.warning, /forward-only/);
  assert.equal(rollbackPlan({ releases: [app.releases![0]] }, 'prod'), null, 'nothing to roll back to');
  assert.equal(rollbackTarget(app, 'dev'), null);
});

// ---------------------------------------------------------------- auto-dev ----

const greenRecord = (sha: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  sha, status: 'finished', trigger: 'push', engine: 'tekton', runRef: 'chk-1', startedAt: '2026-11-27T00:00:00Z', finishedAt: '2026-11-27T00:05:00Z', error: null, digest: D1,
  checks: [...REQUIRED_GATES.map((id) => ({ id, status: 'pass' as const, detail: 'ok' })), { id: 'scan', status: 'pass', detail: 'ok' }, { id: 'image-build', status: 'pass', detail: 'ok' }, { id: 'image-push', status: 'pass', detail: 'ok' }, { id: 'scan-image', status: 'pass', detail: 'ok' }],
  ...over,
});

test('auto-dev: only a finished, green, image-scanned build with a digest, for the newest commit, once', () => {
  const rec = greenRecord(SHA('a'));
  const app = { templateVersion: 2 as const, checks: [rec], releases: [] as AppRelease[] };
  flag(false);
  assert.equal(autoDevDecision(app, rec).ok, false, 'switch off');
  flag(true);
  assert.deepEqual(autoDevDecision(app, rec), { ok: true, digest: D1 });
  assert.equal(autoDevDecision({ ...app, templateVersion: undefined } as never, rec).ok, false, 'v1 app');
  assert.equal(autoDevDecision(app, { ...rec, status: 'running' }).ok, false, 'running');
  assert.equal(autoDevDecision(app, greenRecord(SHA('a'), { checks: rec.checks.map((c) => (c.id === 'tests' ? { ...c, status: 'fail' } : c)) })).ok, false, 'red');
  assert.equal(autoDevDecision(app, greenRecord(SHA('a'), { checks: rec.checks.filter((c) => c.id !== 'scan-image') })).ok, false, 'no image scan');
  assert.equal(autoDevDecision(app, greenRecord(SHA('a'), { digest: undefined })).ok, false, 'no digest');
  assert.equal(autoDevDecision({ ...app, checks: [greenRecord(SHA('b')), rec] }, rec).ok, false, 'a newer commit exists');
  assert.equal(autoDevDecision({ ...app, releases: [rel({ id: 'x', env: 'dev', at: '1', sha: SHA('a'), digest: D1, state: 'failed' })] }, rec).ok, false, 'already released (even failed: no automatic retry)');
});

// ---------------------------------------------------------------- logs ----

test('redaction: tokens, JWTs, credentials, keys and the values of the app\'s own secret names', () => {
  const raw = [
    'token sos_abcdefghijklmnop12 used',
    'auth eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
    'Authorization: Bearer abcdefghijklmnop',
    'postgres://app:hunter2@apps-pg-rw:5432/db',
    'PGPASSWORD=supersecret',
    'PAYMENT_API_KEY=pk_live_123 and {"PAYMENT_API_KEY":"pk_live_456"}',
    '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    'ordinary line 42',
  ].join('\n');
  const out = redactLogs(raw, ['PAYMENT_API_KEY']);
  for (const s of ['sos_abcdefghijklmnop12', 'c2lnbmF0dXJl', 'abcdefghijklmnop', 'hunter2', 'supersecret', 'pk_live_123', 'pk_live_456', 'MIIabc']) assert.ok(!out.includes(s), `${s} leaked`);
  assert.ok(out.includes('ordinary line 42'));
  assert.ok(out.includes(REDACTED));
});

test('logs are read ONLY from the app\'s own pods (exact name label), redacted; a slot exists in Dev only', async () => {
  const app = { id: 'a1', domain: 'sales', slug: 'orders' } as App;
  const own = appResourceName('sales', 'orders');
  const calls: string[] = [];
  const k8s = async (_m: string, path: string) => {
    calls.push(path);
    return { status: 200, body: { items: [
      { metadata: { name: `${own}-abc`, creationTimestamp: '2', labels: { 'app.kubernetes.io/name': own } }, status: { phase: 'Running' } },
      { metadata: { name: 'intruder', creationTimestamp: '3', labels: { 'app.kubernetes.io/name': appResourceName('hr', 'orders') } }, status: { phase: 'Running' } },
    ] } };
  };
  const texts: string[] = [];
  const view = await readAppLogs(app, { env: 'prod', tail: 50 }, { k8s, k8sText: async (p) => (texts.push(p), { status: 200, text: 'hello PGPASSWORD=x1y2z3' }), secretNames: async () => [] });
  assert.match(calls[0], /^\/api\/v1\/namespaces\/apps-prod\/pods\?labelSelector=/);
  assert.ok(calls[0].includes(encodeURIComponent(`app.kubernetes.io/name=${own}`)));
  assert.deepEqual(view.pods.map((p) => p.name), [`${own}-abc`], 'a pod with another app\'s label is never read');
  assert.equal(texts.length, 1);
  assert.ok(!view.text.includes('x1y2z3'));
  await assert.rejects(readAppLogs(app, { env: 'prod', slot: 'p1' }, { k8s }), (e: Error & { status?: number }) => e.status === 400);
});

// ---------------------------------------------------------------- needs-rebuild ----

const legacyTree = (image: string) => [{ path: 'k8s/deployment.yaml', content: yaml.dump({ kind: 'Deployment', spec: { template: { spec: { containers: [{ name: 'app', image }] } } } }) }];

test('needs-rebuild: an image on another registry is MARKED only (the reconcile has no cluster client), and unmarked when fixed', async () => {
  assert.match(legacyRegistryReason(legacyTree(`forgejo.old/x/orders@${D1}`), 'zot.example') ?? '', /forgejo.old/);
  assert.equal(legacyRegistryReason(legacyTree(`zot.example/orders@${D1}`), 'zot.example'), null);
  const app = { id: 'a1', serveMode: 'image', status: 'active', deploy: { state: 'live', approvedSha: 'x' } } as unknown as App;
  let tree = legacyTree(`forgejo.old/x/orders@${D1}`);
  const persisted: string[] = [];
  const deps = { apps: async () => [app], readTree: async () => ({ kind: 'tree' as const, files: tree }), persist: async (a: App) => persisted.push(a.deploy.state), registry: 'zot.example' };
  flag(false);
  assert.deepEqual(await markNeedsRebuild(deps), { marked: [], unmarked: [] }, 'nothing while the switch is off');
  flag(true);
  assert.deepEqual(await markNeedsRebuild(deps), { marked: ['a1'], unmarked: [] });
  assert.equal(app.deploy.state, 'needs-rebuild');
  tree = legacyTree(`zot.example/orders@${D1}`);
  assert.deepEqual(await markNeedsRebuild(deps), { marked: [], unmarked: ['a1'] });
  assert.equal(app.deploy.state, 'live');
  assert.deepEqual(persisted, ['needs-rebuild', 'live']);
});

test('run_app_migration: admin only, only a marked app, scales the legacy Deployment to 0 (undo → 1)', async () => {
  flag(true);
  const app = { id: 'a1', name: 'Orders', slug: 'orders', domain: 'sales', deploy: { state: 'needs-rebuild' } } as unknown as App;
  const calls: { path: string; body: unknown }[] = [];
  const k8s = async (_m: string, path: string, body?: unknown) => (calls.push({ path, body }), { status: 200, body: {} });
  const admin = { id: 'root', role: 'admin', domains: [] } as never;
  const creator = { id: 'alice', role: 'creator', domains: ['sales'] } as never;
  await assert.rejects(runAppMigration(app, creator, { k8s }), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(calls.length, 0);
  const listApps = async () => [app];
  const r = await runAppMigration(app, admin, { k8s, namespace: 'agentic-apps', listApps });
  assert.equal(r.replicas, 0);
  assert.deepEqual(calls[0], { path: '/apis/apps/v1/namespaces/agentic-apps/deployments/app-orders', body: undefined }, 'ownership is read first');
  assert.deepEqual(calls[1], { path: '/apis/apps/v1/namespaces/agentic-apps/deployments/app-orders/scale', body: { spec: { replicas: 0 } } });
  assert.equal((await runAppMigration(app, admin, { k8s, namespace: 'agentic-apps', undo: true, listApps })).replicas, 1);
  await assert.rejects(runAppMigration({ ...app, deploy: { state: 'live' } } as never, admin, { k8s }), (e: Error & { status?: number }) => e.status === 409);
});

// ---------------------------------------------------------------- go-live gate, consequences ----

test('Prod takes only a running Dev release whose own run was green, image-scanned and built that digest', () => {
  const dev = rel({ id: 'd1', env: 'dev', at: '1', sha: SHA('a'), digest: D1 });
  const app = { checks: [greenRecord(SHA('a'))] };
  assert.equal(prodGateRefusal(app, dev), null);
  assert.match(prodGateRefusal(app, null) ?? '', /no running Dev release/);
  assert.match(prodGateRefusal(app, { ...dev, env: 'prod' }) ?? '', /not a Dev release/);
  assert.match(prodGateRefusal(app, { ...dev, slot: 'p1' }) ?? '', /not a Dev release/);
  assert.match(prodGateRefusal(app, { ...dev, state: 'failed' }) ?? '', /failed/);
  assert.match(prodGateRefusal(app, { ...dev, digest: D2 }) ?? '', /refuses/);
  assert.match(prodGateRefusal({ checks: [greenRecord(SHA('a'), { checks: greenRecord(SHA('a')).checks.filter((c) => c.id !== 'scan-image') })] }, dev) ?? '', /image scan/);
});

test('unreviewed pushed changes block Domain and Company go-live, never My', () => {
  assert.equal(unreviewedGoLiveBlock({ name: 'Orders', unreviewed: ['p1'] }, 'my'), null);
  assert.match(unreviewedGoLiveBlock({ name: 'Orders', unreviewed: ['p1', 'p2'] }, 'domain') ?? '', /unreviewed changes \(p1, p2\).*the domain/);
  assert.match(unreviewedGoLiveBlock({ name: 'Orders', unreviewed: ['p1'] }, 'company') ?? '', /the company/);
  assert.equal(unreviewedGoLiveBlock({ name: 'Orders', unreviewed: [] }, 'domain'), null);
});

test('the go-live confirm dialog names the release, the pending migrations and the backup state', () => {
  const app = { visibility: 'Shared', unreviewed: ['p9'], database: { prod: { migrations: { applied: ['0001_init'] } } }, releases: [rel({ id: 'd1', env: 'dev', at: '1', sha: SHA('b') })] } as unknown as App;
  const files = [{ path: 'db/migrations/0001_init.sql' }, { path: 'db/migrations/0002_orders.sql' }, { path: 'src/x.ts' }];
  assert.deepEqual(pendingProdMigrations(app, files), ['0002_orders']);
  const s = consequenceSentences(app, files);
  assert.match(s[0], /Dev release d1.*nothing is rebuilt/);
  assert.match(s[1], /0002_orders/);
  assert.match(s.join(' '), /Blocked: 1 change/);
  assert.match(s.join(' '), /no backup configured/);
  assert.deepEqual(consequenceSentences({ ...app, releases: [] } as App, files), ['There is no running Dev release yet, so there is nothing to take live in Prod.']);
});

// ---------------------------------------------------------------- the run record ----

test('the run record: image tasks become checks, digest and criteria come from the PipelineRun results only', () => {
  const tr = (task: string, status: 'True' | 'False') => ({ metadata: { name: `run-${task}`, labels: { 'tekton.dev/pipelineTask': task } }, status: { conditions: [{ type: 'Succeeded', status }], steps: [] } });
  const run = {
    metadata: { name: 'chk-1', labels: { 'soa.dev/sha': SHA('a'), 'soa.dev/trigger': 'push' } },
    spec: {},
    status: { conditions: [{ type: 'Succeeded', status: 'True' }], startTime: '1', completionTime: '2', results: [{ name: 'digest', value: D1 }, { name: 'criteria', value: JSON.stringify({ v: 1, results: { 'US-1/AC-1': { pass: 2, fail: 0 } } }) }] },
  };
  const rec = recordFromRun({ run, taskRuns: [tr('build-image', 'True'), tr('push-image', 'True'), tr('scan-image', 'False')], logs: {} });
  assert.equal(rec.digest, D1);
  assert.deepEqual(rec.criteria, { v: 1, results: { 'US-1/AC-1': { pass: 2, fail: 0 } } });
  assert.deepEqual(rec.checks.filter((c) => c.id.startsWith('image-') || c.id === 'scan-image').map((c) => `${c.id}:${c.status}`), ['image-build:pass', 'image-push:pass', 'scan-image:fail']);
  const none = recordFromRun({ run: { ...run, status: { ...run.status, results: [{ name: 'digest', value: 'latest' }] } }, taskRuns: [], logs: {} });
  assert.equal(none.digest, undefined, 'a malformed digest is no digest');
  assert.equal(parseCriteria('{"v":1,"results":{"US-1/AC-1":{"pass":-1,"fail":0}}}'), undefined);
  assert.equal(parseCriteria('not json'), undefined);
});

// ---------------------------------------------------------------- build loop (coordinator request) ----

test('the agentic build of a v2 app is test-first and story-tagged (agreed stories of the target only); v1 unchanged', async () => {
  const { appBuilderTestFirst } = await import('@tabs/software/lib/builder/loop-server');
  const crit = { id: 'AC-1', title: 'ok', given: ['g'], when: ['w'], then: ['t'] };
  const story = (id: string, epic: string, state: 'draft' | 'agreed') => ({ id, epic, title: id, asA: 'a', iWant: 'b', soThat: 'c', state, criteria: [crit], notes: '', path: `stories/${id}.md` });
  const app = { templateVersion: 2, stories: { sha: 'x', index: { sha: 'x', epics: [], stories: [story('US-1', 'EP-1', 'agreed'), story('US-2', 'EP-1', 'draft'), story('US-3', 'EP-2', 'agreed')] } } } as unknown as App;
  flag(true);
  const all = await appBuilderTestFirst(app, { kind: 'app' }, []);
  assert.deepEqual(all.storyRefs, ['US-1', 'US-3']);
  assert.equal(all.testsFirst?.files.length, 2);
  const one = await appBuilderTestFirst(app, { kind: 'epic', epicId: 'EP-2' }, []);
  assert.deepEqual(one.storyRefs, ['US-3']);
  assert.deepEqual(one.criteria, ['US-3/AC-1']);
  flag(false);
  assert.deepEqual(await appBuilderTestFirst(app, { kind: 'app' }, []), {});
});

// ---------------------------------------------------------------- security review of #400 ----

test('no preview slot host ever equals any app\'s env host (incl. cut and hashed labels, 2-character and -p1 slugs)', () => {
  const slugs = ['x', 'ab', 'orders', 'orders-p1', 'orders-p2', 'x-p1', 'p1', 'a-b', 'y'.repeat(62), 'z'.repeat(63), `${'q'.repeat(58)}-p1`, `${'w'.repeat(61)}-p2`];
  const env = new Set(slugs.flatMap((s) => [appEnvHost('sales', s, 'dev', 'apps.example'), appEnvHost('sales', s, 'prod', 'apps.example')]));
  for (const s of slugs) {
    for (const slot of ['p1', 'p2'] as const) {
      const h = appEnvHost('sales', s, 'dev', 'apps.example', slot)!;
      assert.ok(!env.has(h), `${s}/${slot}: ${h} is an env host`);
      assert.ok(h.split('.')[0].length <= 63, h);
      assert.ok(!/^..--/.test(h), `${h}: no R-LDH label`);
    }
  }
  assert.equal(appEnvHost('sales', 'orders', 'dev', 'apps.example', 'p1'), 'orders--p1.sales.dev.apps.example');
});

test('a new v2 app never takes a slug ending in -p1/-p2', async () => {
  const { v2AppSlug } = await import('@tabs/software/lib/apps');
  assert.equal(v2AppSlug('Orders P1', []), 'orders-p1-app');
  assert.equal(v2AppSlug('Orders', []), 'orders');
  assert.equal(v2AppSlug('Orders P2', ['orders-p2-app']), 'orders-p2-app-2');
});

test('the legacy Deployment is touched only when it is provably this app\'s (shared namespace, per-domain slugs)', async () => {
  const { legacyOwnership } = await import('./needs-rebuild.ts');
  const me = { id: 'a1', slug: 'orders', domain: 'sales', serveMode: 'image' as const };
  const other = { id: 'a2', slug: 'orders', domain: 'hr', serveMode: 'image' as const };
  const dep = (tag?: string) => ({ metadata: { annotations: tag ? { 'sovereign-os.io/live-tag': tag } : {} } });
  assert.deepEqual(legacyOwnership(me, dep('live/app/a1'), [me, other]), { ok: true });
  assert.equal(legacyOwnership(me, dep('live/app/a2'), [me, other]).ok, false);
  assert.equal(legacyOwnership(me, dep(), [me, other]).ok, false, 'no record and another domain uses the slug: ambiguous');
  assert.deepEqual(legacyOwnership(me, dep('none'), [me]), { ok: true });
  flag(true);
  const app = { ...me, name: 'Orders', deploy: { state: 'needs-rebuild' } } as unknown as App;
  const k8s = async (m: string, path: string) => ({ status: 200, body: m === 'GET' && !path.endsWith('/scale') ? dep('live/app/a2') : {} });
  await assert.rejects(runAppMigration(app, { id: 'root', role: 'admin', domains: [] } as never, { k8s, namespace: 'agentic-apps', listApps: async () => [app, other as never] }), (e: Error & { status?: number }) => e.status === 409);
});

test('the CA publisher\'s egress label is reserved: an app pod carrying soa.dev/role is refused at deploy', () => {
  const host = appEnvHost('sales', 'orders', 'prod', 'apps.example')!;
  const ctx = { ...CTX, host, domain: 'sales', templateVersion: 2 as const };
  const files = appDeployFiles({ ...ctx, digest: D1 }).map((f) => (f.path.endsWith('deployment.yaml') ? { ...f, content: f.content.replace(/(template:\n\s+metadata:\n\s+labels:\n)(\s+)/, '$1$2soa.dev/role: apps-pg-ca-publisher\n$2') } : f));
  const p = planAppDeploy(files, ctx);
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.reason, /reserved for the platform/);
});

test('re-review of #400: no slot host of any slug equals another slug\'s slot or env host (generated slugs, short ones, the public hash)', async () => {
  const { appNameHash } = await import('@tabs/software/lib/app-builder-contracts');
  const { v2AppSlug } = await import('@tabs/software/lib/apps');
  const { appCallbackHosts } = await import('../../../../app-token-sources.ts');
  const alpha = 'abc019-';
  const gen: string[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    let s = '';
    for (let j = 0; j < n; j++) s += alpha[Math.floor(rnd() * alpha.length)];
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (s) gen.push(s);
  }
  const short = ['a', 'ab', 'x1', '9z'];
  const hashed = short.map((s) => `${s}-${appNameHash('sales', s)}`); // an app literally slugged like a hashed label
  const slugs = [...new Set([...gen, ...short, ...hashed, 'orders', 'orders-p1', 'y'.repeat(62), `${'q'.repeat(58)}-p1`])];
  const seen = new Map<string, string>();
  for (const s of slugs) {
    const cb = appCallbackHosts('sales', s, 'apps.example')!;
    for (const h of [...cb.prod, ...cb.dev]) {
      const owner = seen.get(h);
      assert.ok(owner === undefined || owner === s, `${h}: shared by '${owner}' and '${s}'`);
      seen.set(h, s);
      assert.ok(h.split('.')[0].length <= 63, h);
    }
    for (const slot of ['p1', 'p2'] as const) assert.equal(appEnvHost('sales', s, 'dev', 'apps.example', slot), cb.dev[slot === 'p1' ? 1 : 2], 'C2 and E in lockstep');
  }
  // A v2 app never gets a short slug, so its slot label is always the plain form.
  for (const s of short) assert.ok(v2AppSlug(s, []).length >= 3, s);
  assert.equal(v2AppSlug('ab', []), 'ab-app');
});

