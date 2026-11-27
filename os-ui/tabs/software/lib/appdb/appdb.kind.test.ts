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
  const steal = structuredClone(good);
  steal.metadata.name = `adm-steal-${Date.now().toString(36)}`;
  steal.spec.template.spec.containers[0].env.push({ name: 'K', valueFrom: { secretKeyRef: { name: 'apps-pg-replication', key: 'tls.key' } } });
  const r1 = await createJob(liveCnpgK8s, steal as never);
  assert.equal(r1.ok, false);
  // 403 from the admission policy (reason Forbidden); RBAC admits Job creates, as the twin below shows
  if (!r1.ok) assert.match(r1.detail, /HTTP 403/);
  const token = structuredClone(good);
  token.metadata.name = `adm-token-${Date.now().toString(36)}`;
  token.spec.template.spec.automountServiceAccountToken = true;
  const r2 = await createJob(liveCnpgK8s, token as never);
  assert.equal(r2.ok, false);
  // NEGATIVE TWIN: the platform's own manifest is admitted (then removed)
  const ok = await createJob(liveCnpgK8s, good as never);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.detail);
  kubectl(['-n', 'apps-dev', 'delete', 'job', good.metadata.name, '--wait=false']);
});
