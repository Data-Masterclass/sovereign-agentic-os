/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (D) - proof on a REAL CloudNativePG cluster that apps cannot reach each other's database
 * USER STORY: As the owner I want "role A cannot connect to database B" proven against the real operator with the
 *             chart's own objects and os-ui's own Kubernetes client under the chart's RBAC, for each isolation layer
 *             separately, plus the network fence and the migrate hook.
 * ARCHITECTURE:
 *   - Set up by tests/app-databases/up.sh (kind + the pinned operator + the chart rendered with the switch on) and
 *     tests/app-databases/migrate-image.sh (the template's `migrate` stage pushed by digest); skipped unless
 *     APPDB_KIND_KUBECONFIG and APPDB_KIND_SA_DIR are set.
 *   - os-ui's live client (`core/infra/k8s.ts`) is pointed at the cluster with the os-ui ServiceAccount's token
 *     (OS_K8S_SA_DIR, KUBERNETES_API): every object is created by the real code path, RBAC and admission included.
 *   - Probes are pods the test (cluster admin) starts with psql from the Cluster's image, labelled like a migrate Job
 *     so the NetworkPolicies admit them to apps-pg:5432 of their own namespace.
 *   - Layer 1 (pg_hba sameuser + reject) is tested as configured; layer 2 (REVOKE CONNECT FROM PUBLIC) is tested by
 *     temporarily relaxing pg_hba to `hostssl all all all`, then restoring it. NEGATIVE TWIN: role A reaches its own
 *     database in both configurations, so a refusal is not a broken probe.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '@tabs/software/lib/apps';

const KCFG = process.env.APPDB_KIND_KUBECONFIG ?? '';
const SA = process.env.APPDB_KIND_SA_DIR ?? '';
const MIGRATE_IMAGE = process.env.APPDB_KIND_MIGRATE_IMAGE ?? '';
const skip = KCFG && SA ? false : 'APPDB_KIND_KUBECONFIG / APPDB_KIND_SA_DIR not set (run tests/app-databases/up.sh)';

const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', KCFG, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

if (!skip) {
  process.env.OS_K8S_SA_DIR = SA;
  process.env.KUBERNETES_API = readFileSync(join(SA, 'server'), 'utf8').trim();
  process.env.SOFTWARE_APP_BUILDER = 'on';
  process.env.SOFTWARE_APP_DATABASES_MODE = 'cnpg';
}
const db = await import('./database.ts');
const mig = await import('./migrations.ts');
const env = await import('./env-secrets.ts');

// A fresh slug per run (the cluster keeps databases between runs); the SAME slug in two domains.
const SLUG = `orders-${Date.now().toString(36)}`;
const appA = { id: 'app_a', domain: 'sales', slug: SLUG, templateVersion: 2, visibility: 'Personal' } as unknown as App;
const appB = { id: 'app_b', domain: 'hr', slug: SLUG, templateVersion: 2, visibility: 'Personal' } as unknown as App;
const deps = () => ({ ...db.liveAppDbDeps(), mode: 'cnpg' as const, persist: async () => undefined });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let image = '';

/** psql as `who` (an app's db Secret) against database `dbname` in `ns`; host overridable. Returns exit code + output. */
function probe(ns: string, name: string, who: App, dbname: string, sql = 'select current_user', host = 'apps-pg-rw'): { code: number; out: string } {
  const secret = db.appDbNames(who.domain, who.slug).secret;
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace: ns, labels: { 'soa.dev/role': 'app-migrate' } },
    spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 26, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'p', image, command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
        env: [
          { name: 'PGHOST', value: host }, { name: 'PGDATABASE', value: dbname }, { name: 'PGSSLMODE', value: 'require' }, { name: 'PGCONNECT_TIMEOUT', value: '8' },
          { name: 'PGUSER', valueFrom: { secretKeyRef: { name: secret, key: 'username' } } },
          { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: secret, key: 'password' } } },
        ],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      }],
    },
  };
  kubectl(['-n', ns, 'delete', 'pod', name, '--ignore-not-found', '--wait=true']);
  kubectl(['apply', '-f', '-'], JSON.stringify(pod));
  for (let i = 0; i < 90; i++) {
    const phase = kubectl(['-n', ns, 'get', 'pod', name, '-o', 'jsonpath={.status.phase}']).trim();
    if (phase === 'Succeeded' || phase === 'Failed') {
      const out = kubectl(['-n', ns, 'logs', name]);
      return { code: phase === 'Succeeded' ? 0 : 1, out };
    }
    execFileSync('sleep', ['2']);
  }
  throw new Error(`probe ${name} did not finish`);
}

async function waitIsolated(app: App) {
  for (let i = 0; i < 120; i++) {
    const v = await db.readAppDatabase({ ...app, database: { dev: { name: '', secret: '', namespace: 'apps-dev', createdAt: '', migrations: { applied: [], lastRunAt: null, status: 'none' } } } } as App, 'dev', deps());
    if (v.isolation.state === 'applied' && v.database?.applied && v.role === 'reconciled') return v;
    if (v.isolation.state === 'failed') throw new Error(`isolation failed: ${v.isolation.reason}`);
    await sleep(3000);
  }
  throw new Error('isolation not applied in time');
}

const hba = (lines: string[]) => kubectl(['-n', 'apps-dev', 'patch', 'cluster', 'apps-pg', '--type=merge', '-p', JSON.stringify({ spec: { postgresql: { pg_hba: lines } } })]);
const CHART_HBA = ['hostssl sameuser all all scram-sha-256', 'host all all all reject'];

before(async () => {
  if (skip) return;
  image = kubectl(['-n', 'apps-dev', 'get', 'cluster', 'apps-pg', '-o', 'jsonpath={.spec.imageName}']).trim();
});
after(() => {
  if (skip) return;
  hba(CHART_HBA);
});

test('two apps with the same slug in two domains get two databases, two roles, two Secrets, created by os-ui under the chart RBAC', { skip, timeout: 600_000 }, async () => {
  const a = await db.ensureAppDatabase({ ...appA }, 'dev', deps());
  const b = await db.ensureAppDatabase({ ...appB }, 'dev', deps());
  assert.notEqual(a.record!.name, b.record!.name);
  assert.notEqual(a.record!.secret, b.record!.secret);
  await waitIsolated(appA);
  await waitIsolated(appB);
  // idempotent: a second ensure changes nothing and keeps the finished REVOKE Job
  const again = await db.ensureAppDatabase({ ...appA }, 'dev', deps());
  assert.equal(again.isolation.state, 'applied');
  // no superuser exists to be leaked
  assert.equal(kubectl(['-n', 'apps-dev', 'get', 'secret', 'apps-pg-superuser', '--ignore-not-found', '-o', 'name']).trim(), '');
});

test('layer 1 (pg_hba sameuser + reject): role A cannot connect to database B; A reaches A', { skip, timeout: 300_000 }, () => {
  const nA = db.appDbNames(appA.domain, appA.slug).ident;
  const nB = db.appDbNames(appB.domain, appB.slug).ident;
  const own = probe('apps-dev', 'probe-a-a', appA, nA);
  assert.equal(own.code, 0, own.out);
  assert.match(own.out, new RegExp(nA));
  const cross = probe('apps-dev', 'probe-a-b', appA, nB);
  assert.equal(cross.code, 1);
  assert.match(cross.out, /pg_hba\.conf rejects connection|no pg_hba\.conf entry/);
  // the cluster's default database is closed too
  assert.equal(probe('apps-dev', 'probe-a-app', appA, 'app').code, 1);
});

test('layer 2 (REVOKE CONNECT FROM PUBLIC), with pg_hba relaxed: role A still cannot connect to database B', { skip, timeout: 300_000 }, async () => {
  const nA = db.appDbNames(appA.domain, appA.slug).ident;
  const nB = db.appDbNames(appB.domain, appB.slug).ident;
  hba(['hostssl all all all scram-sha-256', 'host all all all reject']);
  try {
    let cross = { code: 1, out: '' };
    for (let i = 0; i < 20; i++) {
      cross = probe('apps-dev', 'probe-l2-a-b', appA, nB);
      if (!/pg_hba/.test(cross.out)) break; // the reload reached the instance
      await sleep(3000);
    }
    assert.equal(cross.code, 1);
    assert.match(cross.out, /permission denied for database/, cross.out);
    const own = probe('apps-dev', 'probe-l2-a-a', appA, nA);
    assert.equal(own.code, 0, own.out);
  } finally {
    hba(CHART_HBA);
  }
});

test('network: a pod in apps-dev (even one admitted to its own apps-pg) cannot reach apps-pg of apps-prod', { skip, timeout: 300_000 }, async () => {
  await db.ensureAppDatabase({ ...appA }, 'prod', deps());
  const nA = db.appDbNames(appA.domain, appA.slug).ident;
  const prodFromDev = probe('apps-dev', 'probe-dev-prod', appA, nA, 'select 1', 'apps-pg-rw.apps-prod.svc.cluster.local');
  assert.equal(prodFromDev.code, 1);
  assert.match(prodFromDev.out, /timeout|timed out|could not connect/i, prodFromDev.out);
});

test('the migrate hook runs the release image by digest as the app role, records what it applied, and is idempotent', { skip: skip || (MIGRATE_IMAGE ? false : 'APPDB_KIND_MIGRATE_IMAGE not set (tests/app-databases/migrate-image.sh)'), timeout: 600_000 }, async () => {
  const app = { ...appA } as App;
  await db.ensureAppDatabase(app, 'dev', deps());
  const mdeps = { ...mig.liveMigrateDeps(), ...deps(), findApp: async () => app, timeoutMs: 300_000, pollMs: 2_000 };
  const input = { slug: app.slug, domain: app.domain, env: 'dev' as const, namespace: 'apps-dev', image: MIGRATE_IMAGE, sha: 'a'.repeat(40) };
  const first = await mig.runMigrations(input, mdeps);
  assert.deepEqual(first, { ok: true, applied: ['0001_init'] });
  assert.equal(app.database?.dev?.migrations.status, 'ok');
  assert.deepEqual(app.database?.dev?.migrations.applied, ['0001_init']);
  const second = await mig.runMigrations(input, mdeps);
  assert.deepEqual(second, { ok: true, applied: [] }, 'forward-only and idempotent: nothing to apply the second time');
  // the table exists and belongs to the app role
  const owner = probe('apps-dev', 'probe-owner', appA, db.appDbNames(appA.domain, appA.slug).ident, "select tableowner from pg_tables where tablename = 'app_notes'");
  assert.equal(owner.out.trim(), db.appDbNames(appA.domain, appA.slug).ident);
  // NEGATIVE TWIN: a tag instead of a digest is refused before any Job exists
  const bad = await mig.runMigrations({ ...input, image: 'localhost:5001/appdb-migrate:test' }, mdeps);
  assert.equal(bad.ok, false);
});

test('a failing migration fails the hook with the log tail and records the failure', { skip: skip || (MIGRATE_IMAGE ? false : 'APPDB_KIND_MIGRATE_IMAGE not set'), timeout: 600_000 }, async () => {
  const app = { ...appB } as App;
  await db.ensureAppDatabase(app, 'dev', deps());
  // node-pg-migrate refuses to run when its table records a migration that is not in the image (order check).
  const seeded = probe('apps-dev', 'probe-b-seed', appB, db.appDbNames(appB.domain, appB.slug).ident,
    "create table pgmigrations (id serial primary key, name varchar(255) not null, run_on timestamp not null); insert into pgmigrations (name, run_on) values ('9999_gone', now())");
  assert.equal(seeded.code, 0, seeded.out);
  const mdeps = { ...mig.liveMigrateDeps(), ...deps(), findApp: async () => app, timeoutMs: 300_000, pollMs: 2_000 };
  const r = await mig.runMigrations({ slug: app.slug, domain: app.domain, env: 'dev', namespace: 'apps-dev', image: MIGRATE_IMAGE, sha: 'b'.repeat(40) }, mdeps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /migration failed[\s\S]*the previous one keeps running/);
  assert.equal(app.database?.dev?.migrations.status, 'failed');
});

test('env: a secret is written once, listed by name only, the value is never returned', { skip, timeout: 120_000 }, async () => {
  const d = deps();
  const r = await env.setAppEnv(appA.domain, appA.slug, 'dev', 'alice', { name: 'STRIPE_KEY', value: 'sk_live_do-not-echo-1234567890', secret: true }, d);
  assert.deepEqual(Object.keys(r.entry).sort(), ['kind', 'name', 'updatedAt', 'updatedBy']);
  assert.ok(!JSON.stringify(r).includes('do-not-echo'));
  const list = await env.listAppEnv(appA.domain, appA.slug, 'dev', d);
  assert.ok(list.some((e) => e.name === 'STRIPE_KEY' && e.kind === 'secret' && e.updatedBy === 'alice'));
  assert.ok(!JSON.stringify(list).includes('do-not-echo'));
  await env.ensurePlatformEnv(appA.domain, appA.slug, 'dev', d, 'https://os.example.test');
  const names = (await env.listAppEnv(appA.domain, appA.slug, 'dev', d)).map((e) => `${e.name}:${e.kind}`);
  assert.ok(names.includes('APP_ENV:platform') && names.includes('OS_PUBLIC_URL:platform'), names.join(','));
  await env.unsetAppEnv(appA.domain, appA.slug, 'dev', 'alice', 'STRIPE_KEY', d);
  assert.ok(!(await env.listAppEnv(appA.domain, appA.slug, 'dev', d)).some((e) => e.name === 'STRIPE_KEY'));
});

test('admission: os-ui cannot start a Job that carries another Secret (CNPG replication cert) or a service-account token', { skip, timeout: 120_000 }, async () => {
  const { createJob, liveCnpgK8s } = await import('@core/adapters/cnpg/client');
  type J = { metadata: { name: string }; spec: { template: { spec: { containers: { env: unknown[] }[]; automountServiceAccountToken?: boolean } } } };
  const good = db.revokeJobManifest('apps-dev', appA.domain, `${appA.slug}-adm`, image) as unknown as J;
  const steal = db.revokeJobManifest('apps-dev', appA.domain, `${appA.slug}-st`, image) as unknown as J;
  steal.spec.template.spec.containers[0].env.push({ name: 'K', valueFrom: { secretKeyRef: { name: 'apps-pg-replication', key: 'tls.key' } } });
  const r1 = await createJob(liveCnpgK8s, steal as never);
  assert.equal(r1.ok, false);
  // 403 from the admission policy (reason Forbidden); RBAC admits Job creates, as the twin below shows
  if (!r1.ok) assert.match(r1.detail, /HTTP 403/);
  const other = db.revokeJobManifest('apps-dev', appA.domain, `${appA.slug}-ot`, image) as unknown as J;
  (other.spec.template.spec.containers[0].env as { name: string; valueFrom?: { secretKeyRef: { name: string } } }[]).forEach((e) => { if (e.valueFrom) e.valueFrom.secretKeyRef.name = db.appDbNames(appB.domain, appB.slug).secret; });
  assert.equal((await createJob(liveCnpgK8s, other as never)).ok, false, 'another app\'s credential is refused');
  const token = db.revokeJobManifest('apps-dev', appA.domain, `${appA.slug}-tk`, image) as unknown as J;
  token.spec.template.spec.automountServiceAccountToken = true;
  const r2 = await createJob(liveCnpgK8s, token as never);
  assert.equal(r2.ok, false);
  // NEGATIVE TWIN: the platform's own manifest is admitted (then removed)
  const ok = await createJob(liveCnpgK8s, good as never);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.detail);
  kubectl(['-n', 'apps-dev', 'delete', 'job', good.metadata.name, '--wait=false']);
});

test('admission (Cluster): os-ui may add only plain app login roles; every other change is refused', { skip, timeout: 120_000 }, async () => {
  const c = await import('@core/adapters/cnpg/client');
  const CL = '/apis/postgresql.cnpg.io/v1/namespaces/apps-dev/clusters/apps-pg';
  const status = async (body: unknown) => (await c.liveCnpgK8s('PATCH', CL, body)).status;
  assert.equal(await status({ spec: { enableSuperuserAccess: true } }), 403, 'superuser access');
  assert.equal(await status({ spec: { postgresql: { pg_hba: ['host all all all trust'] } } }), 403, 'pg_hba');
  assert.equal(await status({ spec: { instances: 2 } }), 403, 'instances');
  assert.equal(await status({ metadata: { annotations: { 'cnpg.io/hibernation': 'on' } } }), 403, 'an annotation');
  const n = db.appDbNames('policy', `p${Date.now().toString(36)}`);
  const role = c.appRoleSpec(n.ident, n.secret);
  for (const [why, bad] of [
    ['superuser', { ...role, superuser: true }],
    ['createrole', { ...role, createrole: true }],
    ['replication', { ...role, replication: true }],
    ['inRoles', { ...role, inRoles: ['pg_read_all_data'] }],
    ['ensure absent', { ...role, ensure: 'absent' }],
    ['another app\'s password Secret', { ...role, passwordSecret: { name: db.appDbNames(appB.domain, appB.slug).secret } }],
    ['a non-app name', { ...role, name: 'postgres' }],
  ] as const) {
    const r = await c.ensureManagedRole(c.liveCnpgK8s, 'apps-dev', 'apps-pg', bad as never);
    assert.equal(!r.ok && r.reason, 'forbidden', why);
  }
  // NEGATIVE TWIN: the app role os-ui really writes is admitted
  const ok = await c.ensureManagedRole(c.liveCnpgK8s, 'apps-dev', 'apps-pg', role);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.detail);
});

test('admission (Database): only name == owner app_…, retain, present, and no extension/schema/fdw', { skip, timeout: 120_000 }, async () => {
  const c = await import('@core/adapters/cnpg/client');
  const n = db.appDbNames('policy', `d${Date.now().toString(36)}`);
  const base = c.databaseManifest('apps-dev', n.database, 'apps-pg', n.ident, n.ident) as { spec: Record<string, unknown> };
  for (const [why, spec] of [
    ['an extension', { ...base.spec, extensions: [{ name: 'adminpack', ensure: 'present' }] }],
    ['a schema', { ...base.spec, schemas: [{ name: 'x', owner: n.ident }] }],
    ['owner differs', { ...base.spec, owner: db.appDbNames(appB.domain, appB.slug).ident }],
    ['reclaim delete', { ...base.spec, databaseReclaimPolicy: 'delete' }],
    ['ensure absent', { ...base.spec, ensure: 'absent' }],
    ['a template', { ...base.spec, template: 'template0' }],
  ] as const) {
    const r = await c.ensureDatabase(c.liveCnpgK8s, { ...base, spec } as never);
    assert.equal(!r.ok && r.reason, 'forbidden', why);
  }
  const ok = await c.ensureDatabase(c.liveCnpgK8s, base as never);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.detail);
});

test('admission (Secrets): only app-…-db/-env, a -db credential is never changed, CNPG\'s Secrets are untouchable', { skip, timeout: 120_000 }, async () => {
  const c = await import('@core/adapters/cnpg/client');
  const S = '/api/v1/namespaces/apps-dev/secrets';
  const mk = (name: string) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'apps-dev' }, data: { x: 'eA==' } });
  assert.equal((await c.liveCnpgK8s('POST', S, mk('apps-pg-evil'))).status, 403);
  assert.equal((await c.liveCnpgK8s('POST', S, mk('anything'))).status, 403);
  const aDb = db.appDbNames(appA.domain, appA.slug).secret;
  assert.equal((await c.liveCnpgK8s('PATCH', `${S}/${aDb}`, { data: { password: Buffer.from('reset').toString('base64') } })).status, 403, 'password reset');
  assert.equal((await c.liveCnpgK8s('DELETE', `${S}/apps-pg-ca`)).status, 403, 'CNPG CA');
  assert.equal((await c.liveCnpgK8s('PATCH', `${S}/apps-pg-replication`, { metadata: { labels: { x: 'y' } } })).status, 403);
});

test('admission (Deployments, Pods): a workload os-ui writes names only its own -db/-env Secret and no cnpg.io label', { skip, timeout: 120_000 }, async () => {
  const c = await import('@core/adapters/cnpg/client');
  const name = db.appDbNames(appA.domain, appA.slug).secret.replace(/-db$/, '');
  const dep = (env: unknown[], labels: Record<string, string> = {}) => ({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'apps-dev' },
    spec: {
      replicas: 1, selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'sovereign-os-apps', ...labels } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{ name: 'app', image, env, securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } }],
        },
      },
    },
  });
  const D = '/apis/apps/v1/namespaces/apps-dev/deployments?dryRun=All';
  const ref = (s: string, key = 'password') => ({ name: 'X', valueFrom: { secretKeyRef: { name: s, key } } });
  assert.equal((await c.liveCnpgK8s('POST', D, dep([ref('apps-pg-replication', 'tls.key')]))).status, 403, 'replication cert');
  assert.equal((await c.liveCnpgK8s('POST', D, dep([ref(db.appDbNames(appB.domain, appB.slug).secret)]))).status, 403, 'another app');
  assert.equal((await c.liveCnpgK8s('POST', D, dep([], { 'cnpg.io/cluster': 'apps-pg', 'cnpg.io/instanceRole': 'primary' }))).status, 403, 'poses as the database');
  assert.equal((await c.liveCnpgK8s('POST', D, dep([], { 'soa.dev/role': 'app-migrate' }))).status, 403, 'poses as a migrate Job');
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${name}-admission`, namespace: 'apps-dev', labels: { 'app.kubernetes.io/name': name } }, spec: dep([ref('apps-pg-ca', 'ca.key')]).spec.template.spec };
  assert.equal((await c.liveCnpgK8s('POST', '/api/v1/namespaces/apps-dev/pods?dryRun=All', pod)).status, 403, 'dry-run pod with the CA key');
  // NEGATIVE TWIN: its own credential and env Secret are admitted
  const own = await c.liveCnpgK8s('POST', D, dep([ref(`${name}-db`)]));
  assert.ok(own.status === 201 || own.status === 200, `own secrets: HTTP ${own.status} ${JSON.stringify(own.body).slice(0, 300)}`);
});
