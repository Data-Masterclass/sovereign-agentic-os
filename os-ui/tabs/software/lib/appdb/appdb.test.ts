/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (D) - unit tests: names, manifests, env block, env/secrets, migrate hook, rights, flag off,
 *             template policy and licences
 * USER STORY: As the owner I want every rule of the app databases pinned: names keyed on domain and slug, a value
 *             never echoed, the migrate Job's fixed command and digest-only image, a failed migration stopping the
 *             release, Prod changes only with the go-live right, and nothing at all while the switch is off.
 * ARCHITECTURE: Kubernetes is an in-memory fake that answers like the API server (GET/POST/PATCH merge/DELETE, 404, 409
 *               on a stale resourceVersion); the real-cluster proof is appdb.kind.test.ts. The template policy runs in
 *               the REAL OPA (binary or the pinned image through docker), like factory-gates.test.ts.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { DEFAULT_GO_LIVE_RULES } from '@core/policy/go-live-rules';
import type { CnpgK8s } from '@core/adapters/cnpg/client';
import type { App } from '@tabs/software/lib/apps';
import { __resetPreDeployHooks, preDeployHookNames } from '@tabs/software/lib/pre-deploy-hooks';

const db = await import('./database.ts');
const mig = await import('./migrations.ts');
const envs = await import('./env-secrets.ts');
const access = await import('./access.ts');
const { appDeploymentEnv } = await import('../deploy-env-block.ts');
const { appDeployFiles, planAppDeploy } = await import('../native-deploy.ts');
const gp = await import('../golden-path.ts');
const ab = await import('../../mcp/app-builder/index.ts');
const { createApp } = await import('../apps.ts');

const ROOT = resolve(process.cwd(), '..');
const flag = (on: boolean) => { process.env.SOFTWARE_APP_BUILDER = on ? 'on' : 'off'; };
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });
let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-appdb-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- a fake API server ----
type Obj = Record<string, unknown> & { metadata?: Record<string, unknown> };
function fakeApi(seed: Record<string, Obj> = {}) {
  const store = new Map<string, Obj>(Object.entries(seed));
  let rv = 100;
  const log: { method: string; path: string; body?: unknown }[] = [];
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === null) return undefined;
    if (typeof b !== 'object' || Array.isArray(b) || typeof a !== 'object' || a === null || Array.isArray(a)) return b;
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      const m = merge(out[k], v);
      if (m === undefined) delete out[k]; else out[k] = m;
    }
    return out;
  };
  const k8s: CnpgK8s = async (method, rawPath, body) => {
    log.push({ method, path: rawPath, body });
    const path = rawPath.split('?')[0];
    if (method === 'GET') {
      if (rawPath.includes('/pods?')) return { status: 200, body: { items: [{ metadata: { name: 'job-pod-1', creationTimestamp: '2026-11-27T00:00:00Z' } }] } };
      const o = store.get(path);
      return o ? { status: 200, body: structuredClone(o) } : { status: 404, body: {} };
    }
    if (method === 'POST') {
      const meta = (body as Obj).metadata as { name: string };
      const key = `${path}/${meta.name}`;
      if (store.has(key)) return { status: 409, body: {} };
      store.set(key, { ...(structuredClone(body) as Obj), metadata: { ...meta, resourceVersion: String(++rv) } });
      return { status: 201, body: {} };
    }
    if (method === 'PATCH') {
      const o = store.get(path);
      if (!o) return { status: 404, body: {} };
      const want = ((body as Obj).metadata as { resourceVersion?: string } | undefined)?.resourceVersion;
      if (want !== undefined && want !== (o.metadata as { resourceVersion: string }).resourceVersion) return { status: 409, body: {} };
      const next = merge(o, body) as Obj;
      (next.metadata as Record<string, unknown>).resourceVersion = String(++rv);
      store.set(path, next);
      return { status: 200, body: structuredClone(next) };
    }
    if (method === 'DELETE') return store.delete(path) ? { status: 200, body: {} } : { status: 404, body: {} };
    return { status: 405, body: {} };
  };
  return { k8s, store, log };
}
const CLUSTER = (ns: string) => `/apis/postgresql.cnpg.io/v1/namespaces/${ns}/clusters/apps-pg`;
const clusterSeed = (ns = 'apps-dev'): Record<string, Obj> => ({
  [CLUSTER(ns)]: { metadata: { name: 'apps-pg', resourceVersion: '1' }, spec: { instances: 1, imageName: 'ghcr.io/cloudnative-pg/postgresql:18.6-minimal-trixie@sha256:' + 'e'.repeat(64) }, status: { phase: 'Cluster in healthy state', readyInstances: 1 } },
});
function depsWith(api: ReturnType<typeof fakeApi>, persisted: App[] = []) {
  return {
    k8s: api.k8s,
    k8sText: async () => ({ status: 200, text: '' }),
    cluster: 'apps-pg',
    namespace: (e: 'dev' | 'prod') => (e === 'prod' ? 'apps-prod' : 'apps-dev'),
    mode: 'cnpg' as const,
    random: () => 'generated-password-0123456789',
    now: () => '2026-11-27T00:00:00.000Z',
    persist: async (a: App) => { persisted.push(structuredClone(a)); },
  };
}
const v2 = (domain: string, slug: string): App => ({ id: `app_${domain}_${slug}`, domain, slug, templateVersion: 2, visibility: 'Personal' } as unknown as App);

// ---------------------------------------------------------------- names ----
test('the same slug in two domains: disjoint database, role, Secrets, Jobs; every name decodes and fits', () => {
  const a = db.appDbNames('sales', 'orders');
  const b = db.appDbNames('hr', 'orders');
  for (const k of Object.keys(a) as (keyof typeof a)[]) assert.notEqual(a[k], b[k], k);
  assert.match(a.ident, /^app_sales_orders_[0-9a-f]{8}$/);
  assert.match(a.secret, /^app-sales-orders-[0-9a-f]{8}-db$/);
  assert.match(a.revokeJob, /-revoke$/);
  assert.match(a.migrateJob, /-migrate$/);
  const long = db.appDbNames('a-very-long-domain-name-that-goes-on', 'and-an-even-longer-application-slug-here');
  for (const v of Object.values(long)) assert.ok(v.length <= 63, v);
  // the hash survives the cut, so two long names still differ
  assert.notEqual(long.ident, db.appDbNames('a-very-long-domain-name-that-goes-on', 'and-an-even-longer-application-slug-herf').ident);
});

// ---------------------------------------------------------------- manifests ----
test('REVOKE Job: psql from the Cluster image, as the app role, exact SQL, restricted, migrate label, only the app db Secret', () => {
  const j = db.revokeJobManifest('apps-dev', 'sales', 'orders', 'img@sha256:1') as { metadata: { labels: Record<string, string> }; spec: { template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> & { containers: { command: string[]; env: { name: string; valueFrom?: { secretKeyRef: { name: string } } }[]; securityContext: Record<string, unknown> }[] } } } };
  const pod = j.spec.template.spec;
  const c = pod.containers[0];
  const n = db.appDbNames('sales', 'orders');
  assert.deepEqual(c.command, ['psql', '-v', 'ON_ERROR_STOP=1', '-X', '-c', `REVOKE CONNECT, TEMPORARY ON DATABASE "${n.ident}" FROM PUBLIC`]);
  assert.equal(j.spec.template.metadata.labels['soa.dev/role'], 'app-migrate');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] });
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  const refs = c.env.filter((e) => e.valueFrom).map((e) => e.valueFrom!.secretKeyRef.name);
  assert.deepEqual([...new Set(refs)], [n.secret]);
  assert.equal(c.env.find((e) => e.name === 'PGUSER')!.valueFrom!.secretKeyRef.name, n.secret);
});

test('migrate Job: the fixed command, release image by digest only, app role, no-verify TLS, restricted, label', () => {
  const img = `zot.agentic-os.svc.cluster.local:5000/apps/sales-1234abcd/orders@sha256:${'f'.repeat(64)}`;
  const j = mig.migrateJobManifest('apps-dev', 'sales', 'orders', img, 'a'.repeat(40)) as { spec: { backoffLimit: number; template: { metadata: { labels: Record<string, string> }; spec: { containers: { image: string; command: string[]; env: { name: string; value?: string }[] }[]; automountServiceAccountToken: boolean } } } };
  const c = j.spec.template.spec.containers[0];
  assert.deepEqual(c.command, ['node', '/app/migrate/node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-m', '/app/migrate/db/migrations', '--migration-file-language', 'sql', '--single-transaction']);
  assert.equal(c.image, img);
  assert.equal(c.env.find((e) => e.name === 'PGSSLMODE')!.value, 'no-verify');
  assert.equal(j.spec.backoffLimit, 0);
  assert.equal(j.spec.template.metadata.labels['soa.dev/role'], 'app-migrate');
  assert.equal(j.spec.template.spec.automountServiceAccountToken, false);
  for (const bad of ['zot/apps/x:latest', 'ubuntu', `docker.io/library/node@sha256:${'f'.repeat(63)}`]) assert.throws(() => mig.migrateJobManifest('apps-dev', 'sales', 'orders', bad, 'a'), /digest only/, bad);
});

test('node-pg-migrate output → applied names; the log tail is redacted', () => {
  assert.deepEqual(mig.appliedMigrations('> Migrating files:\n> - 0001_init\n### MIGRATION 0001_init (UP) ###\nCREATE …\n### MIGRATION 0002_more (UP) ###\nMigrations complete!\n'), ['0001_init', '0002_more']);
  assert.deepEqual(mig.appliedMigrations('No migrations to run!\nMigrations complete!\n'), []);
  assert.equal(mig.redactLog('connect postgres://u:secret@h/db failed, password=hunter2'), 'connect postgres://[redacted] failed, password=[redacted]');
});

// ---------------------------------------------------------------- env block ----
test('deploy env block: keyed on domain and slug, identical in both envs, optional secrets, no credential literal', () => {
  const a = appDeploymentEnv('sales', 'orders');
  const b = appDeploymentEnv('hr', 'orders');
  assert.notDeepEqual(a, b);
  const n = db.appDbNames('sales', 'orders');
  const by = Object.fromEntries(a.env.map((e) => [e.name, e]));
  assert.equal(by.PGHOST.value, 'apps-pg-rw');
  assert.equal(by.PGDATABASE.value, n.ident);
  assert.equal(by.PGSSLMODE.value, 'no-verify');
  assert.equal(by.APP_DOMAIN.value, 'sales');
  assert.deepEqual(by.PGPASSWORD.valueFrom, { secretKeyRef: { name: n.secret, key: 'password', optional: true } });
  assert.deepEqual(a.envFrom, [{ secretRef: { name: n.envSecret, optional: true } }]);
  assert.ok(!a.env.some((e) => e.name === 'APP_ENV'), 'APP_ENV is per env, so it lives in the env Secret, not in the shared manifest');
  // merged ONLY into v2 apps with a domain; v1 manifests are unchanged
  const base = { slug: 'orders', host: 'orders.sales.apps.local', registry: 'reg.example/apps' };
  assert.deepEqual(appDeployFiles({ ...base, domain: 'sales' }), appDeployFiles(base));
  const dep = appDeployFiles({ ...base, domain: 'sales', templateVersion: 2 }).find((f) => f.path.endsWith('deployment.yaml'))!.content;
  assert.match(dep, /envFrom:/);
  assert.match(dep, new RegExp(n.secret));
});

test('loading the env block registers D\'s two pre-deploy hooks (idempotent)', () => {
  __resetPreDeployHooks();
  mig.registerAppDatabaseHooks();
  mig.registerAppDatabaseHooks();
  assert.deepEqual(preDeployHookNames(), ['app-env', 'migrations']);
});

// ---------------------------------------------------------------- ensureAppDatabase ----
test('ensureAppDatabase: Secret once, managed role, Database, REVOKE Job, record by name only; a second call changes nothing', async () => {
  flag(true);
  const api = fakeApi(clusterSeed());
  const persisted: App[] = [];
  const app = v2('sales', 'orders');
  const view = await db.ensureAppDatabase(app, 'dev', depsWith(api, persisted));
  const n = db.appDbNames('sales', 'orders');
  const secret = api.store.get(`/api/v1/namespaces/apps-dev/secrets/${n.secret}`)!;
  assert.equal(secret.type, 'kubernetes.io/basic-auth');
  assert.equal(Buffer.from((secret.data as Record<string, string>).username, 'base64').toString(), n.ident);
  const roles = ((api.store.get(CLUSTER('apps-dev'))!.spec as Record<string, unknown>).managed as { roles: { name: string; passwordSecret: { name: string } }[] }).roles;
  assert.deepEqual(roles.map((r) => [r.name, r.passwordSecret.name]), [[n.ident, n.secret]]);
  const dbo = api.store.get(`/apis/postgresql.cnpg.io/v1/namespaces/apps-dev/databases/${n.database}`)!;
  assert.deepEqual([(dbo.spec as Record<string, unknown>).name, (dbo.spec as Record<string, unknown>).owner], [n.ident, n.ident]);
  assert.ok(api.store.has(`/apis/batch/v1/namespaces/apps-dev/jobs/${n.revokeJob}`));
  assert.deepEqual(persisted.at(-1)!.database!.dev, { name: n.ident, secret: n.secret, namespace: 'apps-dev', createdAt: '2026-11-27T00:00:00.000Z', migrations: { applied: [], lastRunAt: null, status: 'none' } });
  assert.ok(!JSON.stringify(view).includes('generated-password'), 'the view never carries the password');
  assert.ok(!JSON.stringify(persisted).includes('generated-password'), 'the record never carries the password');
  assert.equal(view.backup.note, 'no backup configured');
  const writes = api.log.filter((l) => l.method !== 'GET').length;
  await db.ensureAppDatabase(app, 'dev', depsWith(api, persisted));
  assert.equal(api.log.filter((l) => l.method !== 'GET').length, writes + 2, 'only the two idempotent creates (Secret, Database) are re-sent and answered 409; no patch, and the running REVOKE Job is left alone');
  assert.equal(persisted.length, 1, 'nothing new to persist');
});

test('ensureAppDatabase refusals: flag off, v1 app, external mode, no mode, cluster missing', async () => {
  const api = fakeApi(clusterSeed());
  flag(false);
  await assert.rejects(db.ensureAppDatabase(v2('sales', 'orders'), 'dev', depsWith(api)), (e: Error & { code?: string }) => e.code === 'app_builder_disabled');
  flag(true);
  await assert.rejects(db.ensureAppDatabase({ ...v2('sales', 'orders'), templateVersion: undefined } as App, 'dev', depsWith(api)), (e: Error & { status?: number }) => e.status === 409);
  await assert.rejects(db.ensureAppDatabase(v2('sales', 'orders'), 'dev', { ...depsWith(api), mode: 'external' }), (e: Error & { status?: number }) => e.status === 501 && /designed but not built/.test(e.message));
  await assert.rejects(db.ensureAppDatabase(v2('sales', 'orders'), 'dev', { ...depsWith(api), mode: '' }), (e: Error & { status?: number }) => e.status === 503);
  await assert.rejects(db.ensureAppDatabase(v2('sales', 'orders'), 'prod', depsWith(api)), (e: Error & { status?: number }) => e.status === 404 && /apps-prod\/apps-pg/.test(e.message));
  assert.equal(api.log.filter((l) => l.method !== 'GET').length, 0, 'no refusal wrote anything');
});

// ---------------------------------------------------------------- migrate hook ----
function migDeps(api: ReturnType<typeof fakeApi>, app: App | null, jobOutcome: 'Complete' | 'Failed' | 'never', log = '') {
  const base = depsWith(api);
  return {
    ...base,
    k8s: (async (method, path, body) => {
      const r = await api.k8s(method, path, body);
      if (method === 'POST' && path.endsWith('/jobs') && jobOutcome !== 'never') {
        const name = ((body as Obj).metadata as { name: string }).name;
        const key = `${path}/${name}`;
        const o = api.store.get(key)!;
        api.store.set(key, { ...o, status: { conditions: [{ type: jobOutcome, status: 'True', reason: jobOutcome === 'Failed' ? 'BackoffLimitExceeded' : undefined }] } });
      }
      return r;
    }) as CnpgK8s,
    k8sText: async () => ({ status: 200, text: log }),
    findApp: async () => app,
    sleep: async () => undefined,
    timeoutMs: 10,
    pollMs: 1,
  };
}
const IMG = `zot:5000/apps/sales-1/orders@sha256:${'c'.repeat(64)}`;
const input = (env: 'dev' | 'prod' = 'dev') => ({ slug: 'orders', domain: 'sales', env, namespace: env === 'dev' ? 'apps-dev' : 'apps-prod', image: IMG, sha: 'a'.repeat(40) });

test('migrate hook: success applies, records and reports node-pg-migrate\'s own list', async () => {
  flag(true);
  const api = fakeApi(clusterSeed());
  const app = v2('sales', 'orders');
  await db.ensureAppDatabase(app, 'dev', depsWith(api));
  const r = await mig.runMigrations(input(), migDeps(api, app, 'Complete', '### MIGRATION 0001_init (UP) ###\nMigrations complete!\n'));
  assert.deepEqual(r, { ok: true, applied: ['0001_init'] });
  assert.deepEqual(app.database!.dev!.migrations, { applied: ['0001_init'], lastRunAt: '2026-11-27T00:00:00.000Z', status: 'ok' });
});

test('migrate hook: a failed migration fails the release with the reason and the log tail, and records failed', async () => {
  flag(true);
  const api = fakeApi(clusterSeed());
  const app = v2('sales', 'orders');
  await db.ensureAppDatabase(app, 'dev', depsWith(api));
  const r = await mig.runMigrations(input(), migDeps(api, app, 'Failed', 'error: relation "x" does not exist\n'));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /migration failed \(BackoffLimitExceeded\); the release was not rolled out and the previous one keeps running/);
    assert.match(r.reason, /relation "x" does not exist/);
  }
  assert.equal(app.database!.dev!.migrations.status, 'failed');
  const t = await mig.runMigrations(input(), migDeps(api, app, 'never'));
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.reason, /did not finish within/);
});

test('migrate hook: an app without a database, a v1 app: nothing to do; the first Prod release creates Prod\'s database; flag off refuses', async () => {
  flag(true);
  const api = fakeApi({ ...clusterSeed('apps-dev'), ...clusterSeed('apps-prod') });
  assert.deepEqual(await mig.runMigrations(input(), migDeps(api, v2('sales', 'orders'), 'Complete')), { ok: true, applied: [] });
  assert.deepEqual(await mig.runMigrations(input(), migDeps(api, { ...v2('sales', 'orders'), templateVersion: undefined } as App, 'Complete')), { ok: true, applied: [] });
  assert.equal(api.log.length, 0);
  const app = v2('sales', 'orders');
  await db.ensureAppDatabase(app, 'dev', depsWith(api));
  const r = await mig.runMigrations(input('prod'), migDeps(api, app, 'Complete', 'No migrations to run!\n'));
  assert.deepEqual(r, { ok: true, applied: [] });
  assert.ok(app.database!.prod, 'Prod database created on the first Prod release');
  assert.ok(api.store.has(`/apis/batch/v1/namespaces/apps-prod/jobs/${db.appDbNames('sales', 'orders').migrateJob}`));
  flag(false);
  assert.equal((await mig.runMigrations(input(), migDeps(api, app, 'Complete'))).ok, false);
});

// ---------------------------------------------------------------- env and secrets ----
test('env names: the rule, reserved prefixes and runtime names are refused', () => {
  for (const ok of ['STRIPE_KEY', 'A', 'X1_2']) assert.equal(envs.envNameRefusal(ok), null, ok);
  for (const bad of ['', 'lower', '1ABC', 'A-B', 'A'.repeat(65), 'PGHOST', 'PG_ANY', 'OS_PUBLIC_URL', 'APP_ENV', 'KUBERNETES_SERVICE_HOST', 'PORT', 'NODE_OPTIONS']) assert.ok(envs.envNameRefusal(bad), bad);
});

test('set/list/unset: write-only, metadata only, the value never appears in a return value, an error or the annotation', async () => {
  const api = fakeApi();
  const d = depsWith(api);
  const secretValue = 'sk_live_NEVER_ECHO_0123456789';
  const r = await envs.setAppEnv('sales', 'orders', 'dev', 'alice', { name: 'STRIPE_KEY', value: secretValue, secret: true }, d);
  assert.deepEqual(r.entry, { name: 'STRIPE_KEY', kind: 'secret', updatedBy: 'alice', updatedAt: '2026-11-27T00:00:00.000Z' });
  await envs.setAppEnv('sales', 'orders', 'dev', 'bob', { name: 'LOG_LEVEL', value: 'debug', secret: false }, d);
  const list = await envs.listAppEnv('sales', 'orders', 'dev', d);
  assert.deepEqual(list.map((e) => [e.name, e.kind, e.updatedBy]), [['LOG_LEVEL', 'plain', 'bob'], ['STRIPE_KEY', 'secret', 'alice']]);
  assert.ok(!JSON.stringify([r, list]).includes(secretValue));
  const stored = api.store.get(`/api/v1/namespaces/apps-dev/secrets/${db.appDbNames('sales', 'orders').envSecret}`)!;
  assert.equal(Buffer.from((stored.data as Record<string, string>).STRIPE_KEY, 'base64').toString(), secretValue, 'the value is in the Secret data');
  assert.ok(!JSON.stringify(stored.metadata).includes(secretValue), 'and nowhere in its metadata');
  await assert.rejects(envs.setAppEnv('sales', 'orders', 'dev', 'alice', { name: 'PGPASSWORD', value: secretValue, secret: true }, d), (e: Error) => !e.message.includes(secretValue));
  await assert.rejects(envs.setAppEnv('sales', 'orders', 'dev', 'alice', { name: 'BIG', value: 'x'.repeat(40_000), secret: true }, d), /at most/);
  await envs.unsetAppEnv('sales', 'orders', 'dev', 'alice', 'STRIPE_KEY', d);
  assert.deepEqual((await envs.listAppEnv('sales', 'orders', 'dev', d)).map((e) => e.name), ['LOG_LEVEL']);
  await assert.rejects(envs.unsetAppEnv('sales', 'orders', 'dev', 'alice', 'STRIPE_KEY', d), (e: Error & { status?: number }) => e.status === 404);
  // same slug, other domain: its own Secret
  assert.deepEqual(await envs.listAppEnv('hr', 'orders', 'dev', d), []);
});

test('a change rolls the app (pod-template checksum) in Prod and, in Dev, both preview slots; a missing Deployment is fine', async () => {
  const api = fakeApi({
    [`/apis/apps/v1/namespaces/apps-dev/deployments/${db.appDbNames('sales', 'orders').ident.replace(/_/g, '-')}`]: { metadata: { resourceVersion: '1' } },
  });
  const d = depsWith(api);
  await envs.setAppEnv('sales', 'orders', 'dev', 'alice', { name: 'A', value: 'b', secret: false }, d);
  const patched = api.log.filter((l) => l.method === 'PATCH' && l.path.includes('/deployments/')).map((l) => l.path.split('/').pop());
  assert.equal(patched.length, 3, 'the Deployment and both preview slots were asked to roll');
  assert.ok(patched.some((p) => p!.endsWith('-p1')) && patched.some((p) => p!.endsWith('-p2')));
  const ann = (api.log.find((l) => l.method === 'PATCH' && l.path.includes('/deployments/'))!.body as { spec: { template: { metadata: { annotations: Record<string, string> } } } }).spec.template.metadata.annotations;
  assert.match(ann[envs.ENV_CHECKSUM_ANNOTATION], /^[0-9a-f]{16}$/);
});

test('platform env: APP_ENV and OS_PUBLIC_URL as kind platform, written only when they change', async () => {
  const api = fakeApi();
  const d = depsWith(api);
  assert.deepEqual(await envs.ensurePlatformEnv('sales', 'orders', 'prod', d, 'https://os.example.test'), ['APP_ENV', 'OS_PUBLIC_URL']);
  assert.deepEqual(await envs.ensurePlatformEnv('sales', 'orders', 'prod', d, 'https://os.example.test'), [], 'unchanged: no write');
  const list = await envs.listAppEnv('sales', 'orders', 'prod', d);
  assert.deepEqual(list.map((e) => [e.name, e.kind]), [['APP_ENV', 'platform'], ['OS_PUBLIC_URL', 'platform']]);
  await assert.rejects(envs.unsetAppEnv('sales', 'orders', 'prod', 'alice', 'APP_ENV', d), /set by the platform/);
});

// ---------------------------------------------------------------- rights ----
const user = (id: string, role: CurrentUser['role'], domains: string[]): CurrentUser => ({ id, name: id, role, domains, allDomains: domains, activeDomain: null });

test('Prod writes need the go-live right of the app\'s scope; Dev needs only edit rights (checked by editableApp)', () => {
  const rules = DEFAULT_GO_LIVE_RULES;
  const my = { visibility: 'Personal', domain: 'sales' } as App;
  const shared = { visibility: 'Shared', domain: 'sales' } as App;
  const certified = { visibility: 'Certified', domain: 'sales' } as App;
  assert.equal(access.prodWriteRefusal(rules, my, user('c', 'creator', ['sales'])), null, 'My scope: reviewer none ⇒ the editor');
  assert.match(access.prodWriteRefusal(rules, shared, user('b', 'builder', ['sales']))!, /needs the right to take this app live/);
  assert.equal(access.prodWriteRefusal(rules, shared, user('d', 'domain_admin', ['sales'])), null);
  assert.ok(access.prodWriteRefusal(rules, shared, user('d2', 'domain_admin', ['hr'])), 'a domain admin of another domain');
  assert.ok(access.prodWriteRefusal(rules, certified, user('d', 'domain_admin', ['sales'])));
  assert.equal(access.prodWriteRefusal(rules, certified, user('a', 'admin', [])), null);
  // narrowed active domain does not hide membership
  assert.equal(access.prodWriteRefusal(rules, shared, { ...user('d', 'domain_admin', []), allDomains: ['sales'] }), null);
  assert.throws(() => access.parseEnv('staging'), /dev" or "prod/);
});

test('an app token caller is refused; a non-editor gets 403/404 before anything is read from the cluster', async () => {
  flag(true);
  const alice = user('alice-appdb', 'creator', ['eng']);
  const app = await createApp(alice, { name: 'Appdb Rights', template: 'nextjs-web', templateVersion: 2 });
  await assert.rejects(access.editableApp(app.id, { ...alice, via: 'app:eng/x:dev' }), (e: Error & { status?: number }) => e.status === 403);
  await assert.rejects(access.editableApp(app.id, user('mallory', 'creator', ['eng'])), (e: Error & { status?: number }) => e.status === 403 || e.status === 404);
  assert.equal((await access.editableApp(app.id, alice)).id, app.id);
});

// ---------------------------------------------------------------- MCP: flag off, governance ----
test('flag off: every D tool answers app_builder_disabled before parsing anything; flag on: a v1 app is refused', async () => {
  const names = ['list_app_env', 'set_app_env', 'unset_app_env', 'get_app_database', 'create_app_database'];
  const tools = Object.fromEntries(ab.appBuilderTools.filter((t) => names.includes(t.name)).map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), [...names].sort());
  const alice = user('alice-mcp', 'creator', ['eng']);
  flag(false);
  for (const n of names) await assert.rejects(tools[n].call(alice, {}), (e: Error & { code?: string }) => e.code === 'app_builder_disabled', n);
  flag(true);
  const v1 = await createApp(alice, { name: 'Appdb V1', template: 'nextjs-web' });
  await assert.rejects(tools.list_app_env.call(alice, { appId: v1.id, env: 'dev' }), (e: Error & { status?: number }) => e.status === 409);
  const v2app = await createApp(alice, { name: 'Appdb V2 Env', template: 'nextjs-web', templateVersion: 2 });
  await assert.rejects(tools.set_app_env.call(alice, { appId: v2app.id, env: 'qa', name: 'A', value: 'b' }), (e: Error & { status?: number }) => e.status === 400);
  await assert.rejects(tools.list_app_env.call(alice, { appId: 'app_does_not_exist', env: 'dev' }), (e: Error & { status?: number }) => e.status === 404);
});

// ---------------------------------------------------------------- platform-owned, template ----
test('v2 owns migrate/ (v1 does not); db/migrations stays the author\'s', () => {
  assert.equal(gp.isPlatformOwnedPath('migrate/package.json', 2), true);
  assert.equal(gp.isPlatformOwnedPath('migrate/package-lock.json', 2), true);
  assert.equal(gp.isPlatformOwnedPath('migrate/package.json', 1), false);
  assert.equal(gp.isPlatformOwnedPath('db/migrations/0002_x.sql', 2), false);
  assert.deepEqual([...gp.platformOwnedOf(1)], [...gp.PLATFORM_OWNED], 'v1 frozen');
});

test('the v2 template: Dockerfile copies the migrate stage into /app/migrate; pg pinned; a first migration ships', () => {
  const t = new Map(gp.readTemplate('nextjs-web', 2).map((f) => [f.path, f.content]));
  const docker = t.get('Dockerfile')!;
  assert.match(docker, /FROM node:22-alpine AS migrate/);
  assert.match(docker, /COPY --from=migrate \/app\/migrate \.\/migrate/);
  assert.match(docker, /npm ci --ignore-scripts --no-audit --no-fund --omit=dev/);
  assert.equal(JSON.parse(t.get('package.json')!).dependencies.pg, '8.23.1');
  assert.deepEqual(JSON.parse(t.get('migrate/package.json')!).dependencies, { 'node-pg-migrate': '9.0.0', pg: '8.23.1' });
  assert.match(t.get('db/migrations/0001_init.sql')!, /-- Up Migration[\s\S]*-- Down Migration/);
  // the migrate lockfile is npm's own resolution of exactly that manifest
  const lock = JSON.parse(t.get('migrate/package-lock.json')!) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  assert.equal(lock.packages['node_modules/node-pg-migrate'].version, '9.0.0');
  assert.equal(lock.packages['node_modules/pg'].version, '8.23.1');
  assert.deepEqual(lock.packages[''].dependencies, { 'node-pg-migrate': '9.0.0', pg: '8.23.1' });
  // v1 is untouched
  assert.doesNotMatch(readFileSync(join(ROOT, 'templates/nextjs-web/Dockerfile'), 'utf8'), /migrate/);
});

const PERMISSIVE = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|MIT-0|BlueOak-1\.0\.0)$/;
test('licences: the v2 lock adds only permissive packages; the migrate lock is permissive and its BlueOak packages are attributed', () => {
  const v2lock = JSON.parse(readFileSync(join(ROOT, 'templates/nextjs-web-v2/package-lock.json'), 'utf8')) as { packages: Record<string, { license?: string }> };
  const added = Object.entries(v2lock.packages).filter(([k]) => /node_modules\/(pg|pg-.*|pgpass|postgres-.*|split2|xtend|@types\/pg)$/.test(k));
  assert.ok(added.length >= 10);
  for (const [k, v] of added) assert.match(String(v.license), PERMISSIVE, k);
  const mlock = JSON.parse(readFileSync(join(ROOT, 'templates/nextjs-web-v2/migrate/package-lock.json'), 'utf8')) as { packages: Record<string, { license?: string }> };
  const notice = readFileSync(join(ROOT, 'templates/nextjs-web-v2/migrate/NOTICE'), 'utf8');
  for (const [k, v] of Object.entries(mlock.packages)) {
    if (!k) continue;
    assert.match(String(v.license), PERMISSIVE, k);
    if (!/^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause)$/.test(String(v.license))) assert.ok(notice.includes(`\n${k.replace(/^.*node_modules\//, '')}\n`), `${k} attributed in migrate/NOTICE`);
  }
});

// ---------------------------------------------------------------- the v2 policy in the REAL OPA ----
const OPA_IMAGE = process.env.GOLDEN_PATH_OPA_IMAGE ?? 'openpolicyagent/opa:1.22.4';
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const opaBin = process.env.OPA_BIN ?? (spawnSync('opa', ['version'], { stdio: 'ignore' }).status === 0 ? 'opa' : '');
const skipOpa = opaBin || dockerOk ? false : 'neither an opa binary nor a docker daemon is available';
function denyFor(tree: { path: string; content: string }[]): string[] {
  const dir = mkdtempSync(join(homedir(), '.cache-golden-path-opa-'));
  chmodSync(dir, 0o755);
  try {
    const facts = { files: tree.filter((f) => !f.path.startsWith('vendor/') && /\.(ts|tsx|mjs|js|json|yaml|yml|md|rego|sql)$|Dockerfile|\.env/.test(f.path)) };
    mkdirSync(join(dir, 'policy'), { recursive: true });
    writeFileSync(join(dir, 'policy', 'app-rules.rego'), tree.find((f) => f.path === 'policy/app-rules.rego')!.content);
    writeFileSync(join(dir, 'input.json'), JSON.stringify(facts));
    const args = ['eval', '--format', 'json'];
    const out = opaBin
      ? execFileSync(opaBin, [...args, '-d', join(dir, 'policy'), '-i', join(dir, 'input.json'), 'data.factory.deny'], { encoding: 'utf8' })
      : execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w:ro`, OPA_IMAGE, ...args, '-d', '/w/policy', '-i', '/w/input.json', 'data.factory.deny'], { encoding: 'utf8' });
    return (JSON.parse(out).result?.[0]?.expressions?.[0]?.value ?? []) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const DOC = '/**\n * FEATURE: f\n * USER STORY: u\n * ARCHITECTURE: a\n */\n';
const tree = () => gp.goldenPathFiles('nextjs-web', { name: 'Policy', slug: 'policy' }, 2);

test('REAL OPA (v2): the untouched v2 template passes; pg in src/lib/db is allowed, anywhere else denied; PG* env outside db denied', { skip: skipOpa }, () => {
  assert.deepEqual(denyFor(tree()), []);
  const elsewhere = [...tree(), { path: 'src/app/api/notes/store.ts', content: `${DOC}import pg from 'pg';\nexport const p = new pg.Pool();\n` }];
  assert.ok(denyFor(elsewhere).some((m) => /only through src\/lib\/db/.test(m)));
  const env = [...tree(), { path: 'src/lib/conn.ts', content: `${DOC}export const h = process.env.PGHOST;\n` }];
  assert.ok(denyFor(env).some((m) => /only through src\/lib\/db/.test(m)));
  const dyn = [...tree(), { path: 'src/lib/x.ts', content: `${DOC}export const load = () => import('pg');\n` }];
  assert.ok(denyFor(dyn).some((m) => /only through src\/lib\/db/.test(m)));
  const inDb = [...tree(), { path: 'src/lib/db/notes.ts', content: `${DOC}import { query } from './index.ts';\nexport const list = () => query('select 1');\n` }];
  assert.deepEqual(denyFor(inDb), []);
  // governed shared datastores stay denied everywhere, src/lib/db included
  const mongo = [...tree(), { path: 'src/lib/db/m.ts', content: `${DOC}import { MongoClient } from 'mongodb';\nexport const m = MongoClient;\n` }];
  assert.ok(denyFor(mongo).some((m) => /direct datastore access/.test(m)));
});

// ---------------------------------------------------------------- the deploy gate (review MEDIUM-3/4) ----
const CTX = { slug: 'orders', host: 'orders.sales.apps.local', registry: 'reg.example/apps', ingressClass: 'nginx', tlsIssuer: 'letsencrypt' };
const DIGEST = `sha256:${'a'.repeat(64)}`;
const editDep = (files: { path: string; content: string }[], fn: (s: string) => string) => files.map((f) => (f.path.endsWith('deployment.yaml') ? { ...f, content: fn(f.content) } : f));

test('deploy gate: a v2 app\'s own appResourceName -db/-env Secrets pass; v1-style, another app\'s and CNPG\'s are refused', () => {
  const v2ctx = { ...CTX, domain: 'sales', templateVersion: 2 as const };
  const files = appDeployFiles({ ...v2ctx, digest: DIGEST });
  const plan = planAppDeploy(files, v2ctx);
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  const own = db.appDbNames('sales', 'orders');
  for (const bad of ['app-orders.db', db.appDbNames('hr', 'orders').secret, 'apps-pg-replication']) {
    const p = planAppDeploy(editDep(files, (c) => c.split(own.secret).join(bad)), v2ctx);
    assert.equal(p.ok, false, bad);
    if (!p.ok) assert.match(p.reason, /may reference only its own Secrets/);
  }
  const v1 = planAppDeploy(appDeployFiles({ ...CTX, digest: DIGEST }), CTX);
  assert.equal(v1.ok, true, v1.ok ? '' : v1.reason);
});

test('deploy gate: pod labels cnpg.io/* and soa.dev/role are refused (an app pod may not pose as the database or a migrate Job)', () => {
  const v2ctx = { ...CTX, domain: 'sales', templateVersion: 2 as const };
  const files = appDeployFiles({ ...v2ctx, digest: DIGEST });
  for (const label of ['cnpg.io/cluster: apps-pg', 'cnpg.io/instanceRole: primary', 'soa.dev/role: app-migrate']) {
    const p = planAppDeploy(editDep(files, (c) => c.replace(/(template:\n\s+metadata:\n\s+labels:\n)(\s+)/, `$1$2${label}\n$2`)), v2ctx);
    assert.equal(p.ok, false, label);
    if (!p.ok) assert.match(p.reason, /reserved for the platform/);
  }
});

test('a Secret of the same name that belongs to another app is never taken over', async () => {
  const api = fakeApi({
    [`/api/v1/namespaces/apps-dev/secrets/${db.appDbNames('sales', 'orders').envSecret}`]: { metadata: { name: 'x', resourceVersion: '1', annotations: { 'soa.dev/domain': 'hr', 'soa.dev/slug': 'orders' } }, data: {} },
  });
  await assert.rejects(envs.setAppEnv('sales', 'orders', 'dev', 'alice', { name: 'A', value: 'b', secret: false }, depsWith(api)), /does not belong to this app/);
  assert.ok(!api.log.some((l) => l.method === 'PATCH'), 'nothing written into the foreign Secret');
});

test('reserved env names include the loader, TLS and proxy switches', () => {
  for (const n of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) assert.ok(envs.envNameRefusal(n), n);
});
