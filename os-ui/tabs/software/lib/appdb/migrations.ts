/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - database migrations from git, run before every rollout from the release image
 * USER STORY: As an app builder I add `db/migrations/0002_orders.sql`; the next release migrates Dev (and later Prod)
 *             before the new code starts, and a failing migration stops the release while the old one keeps running.
 * ARCHITECTURE: (spec 6.3, 7 "Migrations from git")
 *   - Before the first migration of a database the isolation Job (database.ts `revokeJobManifest`, the release image,
 *     `node /app/migrate/isolate.mjs`) applies `REVOKE CONNECT, TEMPORARY … FROM PUBLIC` as the app role.
 *   - Two pre-deploy hooks (W0 `registerPreDeployHook`; C2 runs them before every rollout to `apps-dev`/`apps-prod`):
 *       `app-env`     writes the platform keys (APP_ENV, OS_PUBLIC_URL) into the app's env Secret;
 *       `migrations`  for an app that has a database: makes sure THIS env's database exists (the first Prod release
 *                     creates Prod's), then runs the migrate Job and waits for its verdict.
 *   - The migrate Job runs the RELEASE IMAGE (digest only) with the FIXED command of the platform-owned template
 *     (`node /app/migrate/node_modules/node-pg-migrate/bin/node-pg-migrate.js up -m /app/migrate/db/migrations
 *     --migration-file-language sql --single-transaction`): node-pg-migrate (MIT), forward-only, one transaction.
 *     Restricted pod, no service-account token, label `soa.dev/role: app-migrate` (the env's NetworkPolicies admit it
 *     to apps-pg:5432 and nowhere else), the app's own PG* env (pg reads it natively; `PGSSLMODE=no-verify` = TLS
 *     without CA pinning, the libpq `require` behaviour the spec names — pg's own `require` would verify against the
 *     public CA store and refuse CNPG's cluster CA).
 *   - Applied migrations come from node-pg-migrate's own output (`### MIGRATION <name> (UP) ###`); a failure returns
 *     the last log lines (no credential is ever in them: the password is only in the Secret). The result is recorded
 *     on `App.database[env].migrations`.
 *   - Rollback never runs a migration (C2); migrations stay applied, the rollback card warns (expand/contract rule in
 *     the template's docs/rules/own-database.md).
 *   - Registration happens when this module loads (deploy-env-block.ts imports it, and the deploy path always loads
 *     that); `apps.ts` is imported lazily inside the hooks, so there is no import cycle. Both hooks refuse while the
 *     App Builder switch is off.
 */
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import type { Fetched } from '@core/adapters/_contract';
import { createJob, deleteJob, jobLogTail, jobState, type CnpgObj } from '@core/adapters/cnpg/client';
import { appResourceName, templateVersionOf, type AppEnv } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import {
  APP_MIGRATE_ROLE_LABEL,
  APP_UID,
  appDbNames,
  ensureAppDatabase,
  liveAppDbDeps,
  pgEnv,
  restrictedContainer,
  restrictedPod,
  revokeJobManifest,
  type AppDbDeps,
} from '@tabs/software/lib/appdb/database';
import { ensurePlatformEnv } from '@tabs/software/lib/appdb/env-secrets';
import { registerPreDeployHook, type PreDeployHook, type PreDeployInput, type PreDeployResult } from '@tabs/software/lib/pre-deploy-hooks';

/** The fixed migrate command of the `nextjs-web@2` image (its `migrate` Dockerfile stage). Never taken from the app. */
export const MIGRATE_COMMAND = [
  'node',
  '/app/migrate/node_modules/node-pg-migrate/bin/node-pg-migrate.js',
  'up',
  '-m',
  '/app/migrate/db/migrations',
  '--migration-file-language',
  'sql',
  '--single-transaction',
] as const;
const DIGEST_IMAGE = /^[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$/;

export function migrateJobManifest(ns: string, domain: string, slug: string, image: string, sha: string, cluster?: string): CnpgObj {
  if (!DIGEST_IMAGE.test(image)) throw new Error(`the migrate Job runs a release image by digest only, got '${image}'`);
  const n = appDbNames(domain, slug);
  const labels = { 'app.kubernetes.io/managed-by': 'os-ui', 'soa.dev/app': appResourceName(domain, slug), ...APP_MIGRATE_ROLE_LABEL, 'soa.dev/job': 'migrate' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: n.migrateJob, namespace: ns, labels, annotations: { 'soa.dev/domain': domain, 'soa.dev/slug': slug, 'soa.dev/sha': sha } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels },
        spec: {
          ...restrictedPod(APP_UID),
          restartPolicy: 'Never',
          containers: [
            {
              name: 'migrate',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: [...MIGRATE_COMMAND],
              env: pgEnv(domain, slug, 'no-verify', cluster),
              resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
              securityContext: restrictedContainer,
            },
          ],
        },
      },
    },
  };
}

/** node-pg-migrate's own report of what it applied. */
export function appliedMigrations(log: string): string[] {
  return [...log.matchAll(/^### MIGRATION (.+?) \(UP\) ###$/gm)].map((m) => m[1]);
}

/** The log tail with anything that looks like a credential removed (defence in depth; the env holds no password). */
export function redactLog(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
    .replace(/(password[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(-2000);
}

export type MigrateDeps = AppDbDeps & {
  findApp: (domain: string, slug: string) => Promise<App | null>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
};

export const liveMigrateDeps = (): MigrateDeps => ({
  ...liveAppDbDeps(),
  findApp: async (domain, slug) => (await import('@tabs/software/lib/apps')).getAppByDomainSlugInternal(domain, slug),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs: 660_000,
  pollMs: 2_000,
});

const reasonOf = (f: Extract<Fetched<unknown>, { ok: false }>, what: string) => `${what}: ${f.detail}`;

async function waitGone(ns: string, job: string, deps: MigrateDeps): Promise<boolean> {
  for (let waited = 0; waited <= 60_000; waited += deps.pollMs) {
    const s = await jobState(deps.k8s, ns, job);
    if (s.ok && s.value.phase === 'missing') return true;
    await deps.sleep(deps.pollMs);
  }
  return false;
}

type JobRun = { verdict: 'succeeded' | 'failed' | 'timeout'; why: string; log: string; logError: string } | { error: string };

/** Replace the Job of that name with `manifest`, wait for its verdict (bounded) and read its log tail. */
async function runJob(ns: string, name: string, manifest: CnpgObj, what: string, deps: MigrateDeps): Promise<JobRun> {
  const del = await deleteJob(deps.k8s, ns, name);
  if (!del.ok) return { error: reasonOf(del, `removing the previous ${what} job`) };
  if (del.value && !(await waitGone(ns, name, deps))) return { error: `the previous ${what} job is still being removed; try again` };
  const made = await createJob(deps.k8s, manifest);
  if (!made.ok) return { error: reasonOf(made, `starting the ${what} job`) };
  let verdict: 'succeeded' | 'failed' | 'timeout' = 'timeout';
  let why = '';
  for (let waited = 0; waited <= deps.timeoutMs; waited += deps.pollMs) {
    const s = await jobState(deps.k8s, ns, name);
    if (!s.ok) return { error: reasonOf(s, `reading the ${what} job`) };
    if (s.value.phase === 'succeeded' || s.value.phase === 'failed') {
      verdict = s.value.phase;
      why = s.value.reason;
      break;
    }
    await deps.sleep(deps.pollMs);
  }
  const log = await jobLogTail(deps.k8s, deps.k8sText, ns, name, 80);
  return { verdict, why, log: log.ok ? log.value : '', logError: log.ok ? '' : log.detail };
}

const failureOf = (r: Extract<JobRun, { verdict: string }>, what: string, timeoutMs: number) => {
  const tail = redactLog(r.log).trim();
  const head = r.verdict === 'timeout' ? `the ${what} did not finish within ${Math.round(timeoutMs / 1000)} s` : `the ${what} failed${r.why ? ` (${r.why})` : ''}`;
  return `${head}; the release was not rolled out and the previous one keeps running.${tail ? `\n${tail}` : r.logError ? `\n(${r.logError})` : ''}`;
};

/**
 * Isolation layer 2, once per database: the isolation Job (REVOKE CONNECT, TEMPORARY … FROM PUBLIC as the app role)
 * from this release's image. Skipped when an earlier run already succeeded (its Job is kept as the evidence).
 */
export async function isolateAppDatabase(ns: string, domain: string, slug: string, image: string, deps: MigrateDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  const n = appDbNames(domain, slug);
  const done = await jobState(deps.k8s, ns, n.revokeJob);
  if (!done.ok) return { ok: false, reason: reasonOf(done, 'reading the isolation job') };
  if (done.value.phase === 'succeeded') return { ok: true };
  let manifest: CnpgObj;
  try {
    manifest = revokeJobManifest(ns, domain, slug, image, deps.cluster);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const r = await runJob(ns, n.revokeJob, manifest, 'isolation', deps);
  if ('error' in r) return { ok: false, reason: r.error };
  return r.verdict === 'succeeded' ? { ok: true } : { ok: false, reason: failureOf(r, 'database isolation', deps.timeoutMs) };
}

/** Run the app's migrations for one release; the hook's verdict. */
export async function runMigrations(i: PreDeployInput, deps: MigrateDeps = liveMigrateDeps()): Promise<PreDeployResult> {
  if (!appBuilderEnabled()) return { ok: false, reason: 'the App Builder is not enabled' };
  const app = await deps.findApp(i.domain, i.slug);
  if (!app) return { ok: false, reason: `no app ${i.domain}/${i.slug}` };
  if (templateVersionOf(app) !== 2 || !app.database || (!app.database.dev && !app.database.prod)) return { ok: true, applied: [] };
  const env = i.env;
  try {
    await ensureAppDatabase(app, env, deps);
  } catch (e) {
    return { ok: false, reason: `the ${env} database is not ready: ${(e as Error).message}` };
  }
  const ns = i.namespace || deps.namespace(env);
  const n = appDbNames(i.domain, i.slug);
  let manifest: CnpgObj;
  try {
    manifest = migrateJobManifest(ns, i.domain, i.slug, i.image, i.sha, deps.cluster);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const iso = await isolateAppDatabase(ns, i.domain, i.slug, i.image, deps);
  if (!iso.ok) return iso;
  const r = await runJob(ns, n.migrateJob, manifest, 'migrate', deps);
  if ('error' in r) return { ok: false, reason: r.error };
  const applied = r.verdict === 'succeeded' ? appliedMigrations(r.log) : [];
  const record = app.database[env];
  if (record) {
    app.database = { ...app.database, [env]: { ...record, migrations: { applied: r.verdict === 'succeeded' ? [...new Set([...record.migrations.applied, ...applied])] : record.migrations.applied, lastRunAt: deps.now(), status: r.verdict === 'succeeded' ? (applied.length || record.migrations.applied.length ? 'ok' : 'none') : 'failed' } } };
    await deps.persist(app);
  }
  if (r.verdict === 'succeeded') return { ok: true, applied };
  return { ok: false, reason: failureOf(r, 'migration', deps.timeoutMs) };
}

/** Write APP_ENV / OS_PUBLIC_URL for the env of this release (every v2 app, database or not). */
export async function runPlatformEnv(i: PreDeployInput, deps: MigrateDeps = liveMigrateDeps()): Promise<PreDeployResult> {
  if (!appBuilderEnabled()) return { ok: false, reason: 'the App Builder is not enabled' };
  const app = await deps.findApp(i.domain, i.slug);
  if (!app) return { ok: false, reason: `no app ${i.domain}/${i.slug}` };
  if (templateVersionOf(app) !== 2) return { ok: true, applied: [] };
  try {
    await ensurePlatformEnv(i.domain, i.slug, i.env as AppEnv, deps);
    return { ok: true, applied: [] };
  } catch (e) {
    return { ok: false, reason: `writing the platform env: ${(e as Error).message}` };
  }
}

const envHook: PreDeployHook = (i) => runPlatformEnv(i);
const migrationsHook: PreDeployHook = (i) => runMigrations(i);

/** Idempotent (the registry replaces a name in place). */
export function registerAppDatabaseHooks(): void {
  registerPreDeployHook('app-env', envHook);
  registerPreDeployHook('migrations', migrationsHook);
}

registerAppDatabaseHooks();
