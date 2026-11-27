/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - the rollout order: validate, digest in the app's OWN repository, pre-deploy hooks
 *             (platform env, migrations) BEFORE anything is applied, overlay, apply; and the clear "no builder" refusal
 * USER STORY: As the owner I want a failed migration to stop a release before it touches the running one, an image of
 *             another domain never to deploy, and two apps with the same slug in two domains to run side by side.
 * ARCHITECTURE: node:test with every dependency injected (git tree, registry, hooks, Kubernetes apply, store): no cluster.
 *               The hook-ordering test runs W0's real registry (`runPreDeployHooks`) with stand-ins named like D's hooks.
 */
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '@tabs/software/lib/apps';
import { appResourceName } from '@tabs/software/lib/app-builder-contracts';
import { appDeployFiles } from '@tabs/software/lib/native-deploy';
import { imageRepository, RELEASE_PINS_ANNOTATION } from '@core/adapters/zot/client';
import { __resetPreDeployHooks, registerPreDeployHook, runPreDeployHooks } from '@tabs/software/lib/pre-deploy-hooks';
import { rolloutRelease, NO_BUILDER_REASON, type RolloutDeps } from './rollout.ts';
import { appEnvHost } from './overlay.ts';
import { rollbackApp } from './rollback.ts';
import { fillPreview } from './previews.ts';

beforeEach(() => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
});
afterEach(() => {
  delete process.env.SOFTWARE_APP_BUILDER;
  __resetPreDeployHooks();
});

const REG = 'zot.platform.svc.cluster.local:5000';
const PULL = 'registry.dev.example';
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const v2App = (domain: string, slug = 'orders'): App => ({ id: `app_${domain}_${slug}`, name: slug, domain, slug, templateVersion: 2, visibility: 'Personal', releases: [], checks: [], deploy: { state: 'preview', releases: 0 } } as unknown as App);

/** The committed tree of a v2 app (the scaffold: its own names, host and repository, the all-zero digest). */
const treeOf = (app: App) => ({ kind: 'tree' as const, sha: SHA1, files: appDeployFiles({ slug: app.slug, host: appEnvHost(app.domain, app.slug, 'prod', 'apps.example')!, registry: REG, ingressClass: 'nginx', tlsIssuer: 'le', domain: app.domain, templateVersion: 2 }) });

type Log = string[];
function deps(log: Log, over: Partial<RolloutDeps> = {}): RolloutDeps {
  return {
    registry: REG,
    pullRegistry: PULL,
    appsDomain: 'apps.example',
    ingressClass: 'nginx',
    tlsIssuer: 'le',
    readTree: async (app) => (log.push('tree'), treeOf(app)),
    digestExists: async (repo, digest) => (log.push(`digest ${repo}@${digest.slice(7, 9)}`), { ok: true, value: true, at: '' }),
    runHooks: async (i) => (log.push(`hooks ${i.env} ${i.namespace} ${i.image}`), { ok: true, applied: ['0002_orders'] }),
    apply: async (objs, ns) => (log.push(`apply ${ns} ${objs.map((o) => `${String(o.kind)}/${String((o.metadata as { name: string }).name)}`).join(',')}`), { ok: true, applied: objs.map((o) => String(o.kind)) }),
    persist: async () => undefined,
    commitFile: async () => ({ ok: true, recorded: false }),
    audit: () => undefined,
    ...over,
  };
}

test('order: tree → digest in the app\'s own repository → hooks (release image) → apply; the release runs with its migrations', async () => {
  const app = v2App('sales');
  const log: Log = [];
  const r = await rolloutRelease(app, { env: 'dev', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'auto-dev' }, deps(log));
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  const image = `${PULL}/${imageRepository('sales', 'orders')}@${D1}`;
  assert.deepEqual(log.map((l) => l.split(' ')[0]), ['tree', 'digest', 'hooks', 'apply']);
  assert.equal(log[1], `digest ${imageRepository('sales', 'orders')}@11`);
  assert.equal(log[2], `hooks dev apps-dev ${image}`);
  const name = appResourceName('sales', 'orders');
  assert.equal(log[3], `apply apps-dev Deployment/${name},Ingress/${name},Service/${name}`);
  if (!r.ok) return;
  assert.equal(r.url, 'https://orders.sales.dev.apps.example');
  assert.equal(r.release.state, 'running');
  assert.deepEqual(r.release.migrations, { applied: ['0002_orders'], status: 'ok' });
  assert.equal(app.releases?.[0].id, r.release.id);
});

test('pre-deploy hooks run in registration order (D: app-env, migrations); a failed migration stops the rollout before ANY apply', async () => {
  const order: string[] = [];
  registerPreDeployHook('app-env', async () => (order.push('app-env'), { ok: true, applied: [] }));
  registerPreDeployHook('migrations', async () => (order.push('migrations'), { ok: false, reason: 'the migration failed (exit 1); the release was not rolled out' }));
  const app = v2App('sales');
  const log: Log = [];
  const r = await rolloutRelease(app, { env: 'prod', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'go-live' }, deps(log, { runHooks: runPreDeployHooks }));
  assert.deepEqual(order, ['app-env', 'migrations']);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'hooks');
  assert.match(r.reason, /^migrations: the migration failed/);
  assert.ok(!log.some((l) => l.startsWith('apply')), 'nothing was applied');
  assert.equal(r.release?.state, 'failed');
  assert.equal(r.release?.migrations.status, 'failed');
});

test('an image that is not in the app\'s OWN domain repository is never deployed', async () => {
  const app = v2App('sales');
  const log: Log = [];
  const r = await rolloutRelease(app, { env: 'dev', sha: SHA1, digest: D2, by: { id: 'alice' }, reason: 'manual' }, deps(log, { digestExists: async (repo) => ({ ok: true, value: repo === imageRepository('hr', 'orders'), at: '' }) }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'digest');
    assert.match(r.reason, new RegExp(imageRepository('sales', 'orders')));
  }
  assert.ok(!log.some((l) => l.startsWith('hooks') || l.startsWith('apply')));
  // A committed manifest naming another domain's repository is refused before the registry is even asked.
  const foreign = async (a: App) => {
    const t = treeOf(a);
    return { ...t, files: t.files.map((f) => ({ ...f, content: f.content.split(imageRepository('sales', 'orders')).join(imageRepository('hr', 'orders')) })) };
  };
  const r2 = await rolloutRelease(app, { env: 'dev', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'manual' }, deps([], { readTree: foreign }));
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, 'invalid');
});

test('no builder configured: a clear refusal naming what to configure, nothing read or applied', async () => {
  const log: Log = [];
  const r = await rolloutRelease(v2App('sales'), { env: 'dev', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'manual' }, deps(log, { registry: '' }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'no_builder');
    assert.equal(r.reason, NO_BUILDER_REASON);
    assert.match(r.reason, /builder digest.*build isolation/s);
  }
  assert.deepEqual(log, []);
});

test('the same slug in two domains deploys side by side in apps-dev under disjoint names and hosts', async () => {
  const applied: string[] = [];
  const d = (log: Log) => deps(log, { apply: async (objs, ns) => (applied.push(...objs.map((o) => `${ns}/${String((o.metadata as { name: string }).name)}/${String(o.kind)}`)), { ok: true, applied: [] }) });
  const a = await rolloutRelease(v2App('sales'), { env: 'dev', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'auto-dev' }, d([]));
  const b = await rolloutRelease(v2App('hr'), { env: 'dev', sha: SHA1, digest: D1, by: { id: 'bob' }, reason: 'auto-dev' }, d([]));
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(a.url, b.url);
  assert.equal(new Set(applied).size, 6, 'six distinct objects');
  assert.ok(applied.every((x) => x.startsWith('apps-dev/')));
});

test('the Deployment records the release and the release tags the platform keeper must keep', async () => {
  let dep: Record<string, unknown> | undefined;
  const app = v2App('sales');
  const r = await rolloutRelease(app, { env: 'prod', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'go-live' }, deps([], { apply: async (objs) => ((dep = objs.find((o) => o.kind === 'Deployment')), { ok: true, applied: [] }) }));
  assert.ok(r.ok);
  const ann = (dep!.metadata as { annotations: Record<string, string> }).annotations;
  assert.equal(ann['soa.dev/release'], r.ok ? r.release.id : '');
  assert.deepEqual(JSON.parse(ann[RELEASE_PINS_ANNOTATION]), { [`release-prod-${r.ok ? r.release.id : ''}`]: D1 });
  assert.equal(((dep!.spec as { template: { spec: { containers: { image: string }[] } } }).template.spec.containers[0].image), `${PULL}/${imageRepository('sales', 'orders')}@${D1}`);
});

test('a preview slot runs the dev release under the slot names with NO hooks; rollback runs the previous digest with NO hooks', async () => {
  const app = v2App('sales');
  const log: Log = [];
  const r1 = await rolloutRelease(app, { env: 'dev', sha: SHA1, digest: D1, by: { id: 'alice' }, reason: 'auto-dev' }, deps(log));
  assert.ok(r1.ok);
  log.length = 0;
  const p = await fillPreview(app, r1.ok ? r1.release : (null as never), deps(log));
  assert.ok(p.ok);
  assert.ok(!log.some((l) => l.startsWith('hooks')));
  assert.match(log.find((l) => l.startsWith('apply')) ?? '', new RegExp(`Deployment/${appResourceName('sales', 'orders', 'p1')}`));
  await rolloutRelease(app, { env: 'dev', sha: SHA2, digest: D2, by: { id: 'alice' }, reason: 'auto-dev' }, deps([]));
  log.length = 0;
  const rb = await rollbackApp(app, 'dev', { id: 'alice' }, deps(log));
  assert.equal(rb.ok, true, rb.ok ? '' : rb.reason);
  assert.ok(!log.some((l) => l.startsWith('hooks')), 'a rollback runs no migration');
  if (rb.ok) {
    assert.equal(rb.rollout.release.digest, D1);
    assert.equal(app.releases?.find((r) => r.digest === D2 && !r.slot)?.state, 'rolled-back');
  }
});

test('switch off or a v1 app: refused before anything is read', async () => {
  const log: Log = [];
  process.env.SOFTWARE_APP_BUILDER = 'off';
  const off = await rolloutRelease(v2App('sales'), { env: 'dev', sha: SHA1, digest: D1, by: { id: 'a' }, reason: 'manual' }, deps(log));
  assert.ok(!off.ok && off.code === 'disabled');
  process.env.SOFTWARE_APP_BUILDER = 'on';
  const v1 = await rolloutRelease({ ...v2App('sales'), templateVersion: undefined } as App, { env: 'dev', sha: SHA1, digest: D1, by: { id: 'a' }, reason: 'manual' }, deps(log));
  assert.ok(!v1.ok && v1.code === 'not_v2');
  assert.deepEqual(log, []);
});
