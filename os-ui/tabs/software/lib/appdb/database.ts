/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - one Postgres database and one role per app and env (CloudNativePG), isolated from every
 *             other app
 * USER STORY: As an app builder I want my app to get its own database in Dev and Prod with one click, with a password
 *             nobody ever sees, and no other app able to connect to it.
 * ARCHITECTURE: (spec section 7, plan workstream D)
 *   - Names from domain AND slug (spec 2b): database and role `appDbIdent(domain, slug)`; basic-auth Secret and the
 *     `Database` resource `appResourceName(domain, slug, 'db')`; the one-shot REVOKE Job `appResourceName(…, 'revoke')`.
 *     Same names in `apps-dev` and `apps-prod`, so the app's manifest is identical in both envs.
 *   - `ensureAppDatabase(app, env)`: Secret (random password, created once, never read back) → managed role on the
 *     env's `apps-pg` Cluster → `Database` owned by that role → the REVOKE Job, which runs psql from the Cluster's
 *     own image AS THE APP'S ROLE (the database owner): `REVOKE CONNECT, TEMPORARY ON DATABASE <ident> FROM PUBLIC`.
 *     Isolation layer 1 is the Cluster's pg_hba (`hostssl sameuser` then `reject`, chart); layer 2 is that REVOKE.
 *     Every step is idempotent; the Job retries (backoff) until the operator has created the role and database.
 *     os-ui holds no superuser credential: the operator applies role and database inside the instance.
 *   - The record on the app (`App.database[env]`, names only) is written through W0's `persistApp`, loaded lazily so
 *     this module never forms an import cycle with `apps.ts` (which imports `native-deploy.ts` → `deploy-env-block.ts`
 *     → this module).
 *   - `databases.mode: external` (an existing Postgres server plus an admin credential the adapter would use) is
 *     DESIGNED, not built: it refuses with that reason. With no mode configured it refuses too; nothing is guessed.
 */
import { randomBytes } from 'node:crypto';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';
import {
  appRoleSpec,
  createJob,
  createSecretOnce,
  databaseManifest,
  databaseState,
  deleteJob,
  ensureDatabase,
  ensureManagedRole,
  jobState,
  liveCnpgK8s,
  liveCnpgK8sText,
  readCluster,
  roleState,
  type CnpgK8s,
  type CnpgK8sText,
  type CnpgObj,
  type JobState,
} from '@core/adapters/cnpg/client';
import { appDbIdent, appResourceName, templateVersionOf, type AppDatabaseRecord, type AppEnv } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';

/** The label the env namespace's NetworkPolicies admit to apps-pg:5432 (migrate and REVOKE Jobs). */
export const APP_MIGRATE_ROLE_LABEL = { 'soa.dev/role': 'app-migrate' } as const;
export const PG_PORT = 5432;

/** Every name an app database uses, from domain and slug only. */
export function appDbNames(domain: string, slug: string) {
  return {
    ident: appDbIdent(domain, slug),
    secret: appResourceName(domain, slug, 'db'),
    database: appResourceName(domain, slug, 'db'),
    envSecret: appResourceName(domain, slug, 'env'),
    revokeJob: appResourceName(domain, slug, 'revoke'),
    migrateJob: appResourceName(domain, slug, 'migrate'),
  };
}

export const envNamespace = (env: AppEnv): string => (env === 'prod' ? config.appsProdNamespace : config.appsDevNamespace);
/** The read-write Service CNPG creates for the Cluster (`<cluster>-rw`). */
export const clusterHost = (cluster: string = config.appDatabasesCluster): string => `${cluster}-rw`;

const labelsFor = (domain: string, slug: string): Record<string, string> => ({
  'app.kubernetes.io/managed-by': 'os-ui',
  'app.kubernetes.io/part-of': 'sovereign-os-app-databases',
  'soa.dev/app': appResourceName(domain, slug),
});
const annotationsFor = (domain: string, slug: string): Record<string, string> => ({ 'soa.dev/domain': domain, 'soa.dev/slug': slug });

/** The app's basic-auth Secret: `username` = the role, `password` = random. `cnpg.io/reload` lets CNPG pick up a rotation. */
export function dbSecretManifest(ns: string, domain: string, slug: string, password: string): CnpgObj {
  const n = appDbNames(domain, slug);
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/basic-auth',
    metadata: { name: n.secret, namespace: ns, labels: { ...labelsFor(domain, slug), 'soa.dev/app-secret': 'db', 'cnpg.io/reload': 'true' }, annotations: annotationsFor(domain, slug) },
    data: { username: b64(n.ident), password: b64(password) },
  };
}

/** Pod security every Job os-ui starts in an env namespace has (Pod Security `restricted`). */
export function restrictedPod(runAsUser: number) {
  return {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    securityContext: { runAsNonRoot: true, runAsUser, runAsGroup: runAsUser, seccompProfile: { type: 'RuntimeDefault' } },
  };
}
export const restrictedContainer = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
} as const;

/** The libpq/pg connection env from the app's own Secret (never a composed URL). `sslmode` differs by client: see callers. */
export function pgEnv(domain: string, slug: string, sslmode: string, cluster: string = config.appDatabasesCluster) {
  const n = appDbNames(domain, slug);
  return [
    { name: 'PGHOST', value: clusterHost(cluster) },
    { name: 'PGPORT', value: String(PG_PORT) },
    { name: 'PGDATABASE', value: n.ident },
    { name: 'PGSSLMODE', value: sslmode },
    { name: 'PGUSER', valueFrom: { secretKeyRef: { name: n.secret, key: 'username' } } },
    { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: n.secret, key: 'password' } } },
  ];
}

/** CNPG's PostgreSQL images run as uid 26 (`postgres`). */
const PG_IMAGE_UID = 26;

/**
 * The one-shot REVOKE Job: psql from the Cluster's image, as the app role (owner of its database), libpq
 * `sslmode=require` (encrypted). The identifier is `[a-z0-9_]` by construction (`appDbIdent`), so quoting is exact.
 */
export function revokeJobManifest(ns: string, domain: string, slug: string, image: string, cluster: string = config.appDatabasesCluster): CnpgObj {
  const n = appDbNames(domain, slug);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(n.ident)) throw new Error(`not a database identifier: ${n.ident}`);
  const sql = `REVOKE CONNECT, TEMPORARY ON DATABASE "${n.ident}" FROM PUBLIC`;
  const labels = { ...labelsFor(domain, slug), ...APP_MIGRATE_ROLE_LABEL, 'soa.dev/job': 'revoke' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: n.revokeJob, namespace: ns, labels, annotations: annotationsFor(domain, slug) },
    spec: {
      backoffLimit: 8,
      activeDeadlineSeconds: 900,
      // No TTL: the finished Job is the evidence the panel shows ("isolation applied"); it holds no pod.
      template: {
        metadata: { labels },
        spec: {
          ...restrictedPod(PG_IMAGE_UID),
          restartPolicy: 'Never',
          containers: [
            {
              name: 'revoke',
              image,
              command: ['psql', '-v', 'ON_ERROR_STOP=1', '-X', '-c', sql],
              env: pgEnv(domain, slug, 'require', cluster),
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
              securityContext: restrictedContainer,
            },
          ],
        },
      },
    },
  };
}

export type AppDbDeps = {
  k8s: CnpgK8s;
  k8sText: CnpgK8sText;
  cluster: string;
  namespace: (env: AppEnv) => string;
  mode: '' | 'cnpg' | 'external';
  random: () => string;
  now: () => string;
  persist: (app: App) => Promise<unknown>;
};

export const liveAppDbDeps = (): AppDbDeps => ({
  k8s: liveCnpgK8s,
  k8sText: liveCnpgK8sText,
  cluster: config.appDatabasesCluster,
  namespace: envNamespace,
  mode: config.appDatabasesMode,
  random: () => randomBytes(24).toString('base64url'),
  now: () => new Date().toISOString(),
  persist: async (app) => (await import('@tabs/software/lib/apps')).persistApp(app),
});

export type IsolationState = 'applied' | 'pending' | 'failed' | 'missing';
export type AppDatabaseView = {
  env: AppEnv;
  configured: boolean;
  record: AppDatabaseRecord | null;
  /** Connection names only; never a credential. */
  connection: { host: string; port: number; database: string; user: string; secret: string; namespace: string } | null;
  role: 'reconciled' | 'pending' | 'missing' | 'unknown';
  database: { applied: boolean | null; message: string } | null;
  isolation: { state: IsolationState; reason: string };
  /** Backups of app databases are not built (spec 7): the Prod panel says so. */
  backup: { configured: false; note: string };
  cluster: { phase: string; ready: boolean } | null;
  problems: string[];
};

/** Why this app or installation cannot have an app database (null = it can). */
export function databaseRefusal(app: Pick<App, 'templateVersion' | 'domain'>, mode: AppDbDeps['mode']): { status: number; reason: string } | null {
  if (templateVersionOf(app) !== 2) return { status: 409, reason: 'only an App Builder app (nextjs-web@2) has its own database' };
  if (!app.domain) return { status: 409, reason: 'the app has no domain, so its database name cannot be derived' };
  if (mode === 'external') return { status: 501, reason: 'databases.mode "external" is designed but not built yet; use mode "cnpg"' };
  if (mode !== 'cnpg') return { status: 503, reason: 'app databases are not configured on this installation (osUI.software.databases.mode)' };
  return null;
}

const withStatus = (e: Error, status: number) => Object.assign(e, { status });
const fetchedError = (f: Extract<Fetched<unknown>, { ok: false }>, what: string) =>
  withStatus(new Error(`${what}: ${f.detail}`), f.reason === 'not_found' ? 404 : f.reason === 'forbidden' ? 403 : f.reason === 'conflict' ? 409 : f.reason === 'unreachable' || f.reason === 'timeout' ? 503 : 502);

/**
 * Create (or confirm) the app's database for `env`. Idempotent: a second call changes nothing and re-runs the REVOKE
 * Job only when it failed. Throws a status-carrying Error on refusal. Callers check the user's rights first.
 */
export async function ensureAppDatabase(app: App, env: AppEnv, deps: AppDbDeps = liveAppDbDeps()): Promise<AppDatabaseView> {
  assertAppBuilderEnabled();
  const refusal = databaseRefusal(app, deps.mode);
  if (refusal) throw withStatus(new Error(refusal.reason), refusal.status);
  const ns = deps.namespace(env);
  const n = appDbNames(app.domain, app.slug);

  const cluster = await readCluster(deps.k8s, ns, deps.cluster);
  if (!cluster.ok) throw fetchedError(cluster, `the app database cluster ${ns}/${deps.cluster} is not available`);
  if (!cluster.value.imageName) throw withStatus(new Error(`Cluster ${ns}/${deps.cluster} names no image`), 502);

  const secret = await createSecretOnce(deps.k8s, dbSecretManifest(ns, app.domain, app.slug, deps.random()));
  if (!secret.ok) throw fetchedError(secret, 'creating the database credential');
  const role = await ensureManagedRole(deps.k8s, ns, deps.cluster, appRoleSpec(n.ident, n.secret));
  if (!role.ok) throw fetchedError(role, 'creating the database role');
  const db = await ensureDatabase(deps.k8s, databaseManifest(ns, n.database, deps.cluster, n.ident, n.ident, labelsFor(app.domain, app.slug)));
  if (!db.ok) throw fetchedError(db, 'creating the database');

  const revoke = await jobState(deps.k8s, ns, n.revokeJob);
  if (!revoke.ok) throw fetchedError(revoke, 'reading the isolation job');
  if (revoke.value.phase === 'failed') {
    const del = await deleteJob(deps.k8s, ns, n.revokeJob);
    if (!del.ok) throw fetchedError(del, 'removing the failed isolation job');
  }
  if (revoke.value.phase === 'missing' || revoke.value.phase === 'failed') {
    const made = await createJob(deps.k8s, revokeJobManifest(ns, app.domain, app.slug, cluster.value.imageName, deps.cluster));
    // 409: the old failed Job is still being deleted; the next call recreates it.
    if (!made.ok && made.reason !== 'conflict') throw fetchedError(made, 'starting the isolation job');
  }

  const prior = app.database?.[env];
  const record: AppDatabaseRecord = {
    name: n.ident,
    secret: n.secret,
    namespace: ns,
    createdAt: prior?.createdAt ?? deps.now(),
    migrations: prior?.migrations ?? { applied: [], lastRunAt: null, status: 'none' },
  };
  if (JSON.stringify(prior) !== JSON.stringify(record)) {
    app.database = { ...(app.database ?? {}), [env]: record };
    await deps.persist(app);
  }
  return readAppDatabase(app, env, deps);
}

/** What the Database panel and `get_app_database` show: names, live states, migrations, backup state. No credential. */
export async function readAppDatabase(app: App, env: AppEnv, deps: AppDbDeps = liveAppDbDeps()): Promise<AppDatabaseView> {
  const record = app.database?.[env] ?? null;
  const backup = { configured: false as const, note: 'no backup configured' };
  const refusal = databaseRefusal(app, deps.mode);
  const base: AppDatabaseView = { env, configured: !refusal, record, connection: null, role: 'unknown', database: null, isolation: { state: 'missing', reason: '' }, backup, cluster: null, problems: refusal ? [refusal.reason] : [] };
  if (refusal || !record) return base;
  const ns = record.namespace;
  const n = appDbNames(app.domain, app.slug);
  const problems: string[] = [];
  const view: AppDatabaseView = {
    ...base,
    connection: { host: clusterHost(deps.cluster), port: PG_PORT, database: n.ident, user: n.ident, secret: n.secret, namespace: ns },
  };
  const [cluster, role, db, revoke] = await Promise.all([
    readCluster(deps.k8s, ns, deps.cluster),
    roleState(deps.k8s, ns, deps.cluster, n.ident),
    databaseState(deps.k8s, ns, n.database),
    jobState(deps.k8s, ns, n.revokeJob),
  ]);
  if (cluster.ok) view.cluster = { phase: cluster.value.phase, ready: cluster.value.instances > 0 && cluster.value.readyInstances >= cluster.value.instances };
  else problems.push(`cluster: ${cluster.detail}`);
  if (role.ok) view.role = role.value;
  else problems.push(`role: ${role.detail}`);
  if (db.ok) view.database = db.value;
  else problems.push(`database: ${db.detail}`);
  view.isolation = revoke.ok ? isolationOf(revoke.value) : { state: 'missing', reason: revoke.detail };
  view.problems = problems;
  return view;
}

/** The REVOKE Job's phase as the isolation state (the Job is kept after it finished, so its verdict stays readable). */
export function isolationOf(j: JobState): { state: IsolationState; reason: string } {
  if (j.phase === 'succeeded') return { state: 'applied', reason: '' };
  if (j.phase === 'failed') return { state: 'failed', reason: j.reason || 'the isolation job failed' };
  if (j.phase === 'running') return { state: 'pending', reason: 'waiting for the role and database to exist' };
  return { state: 'missing', reason: 'the isolation job is not there; creating the database again starts it' };
}
