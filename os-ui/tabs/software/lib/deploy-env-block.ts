/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the env block a v2 app's Deployment gets (its database and its env/secrets)
 * USER STORY: As an app builder I want my app's database connection and my own env and secrets wired into the
 *             platform-owned deployment manifest, identical in Dev and Prod, without ever seeing a password.
 * ARCHITECTURE:
 *   - EXTENSION POINT created by W0, owned by workstream D (spec section 7 "Injection"): `envFrom` the
 *     `appResourceName(domain, slug, 'env')` Secret (optional; the author's variables and secrets plus the platform
 *     keys APP_ENV and OS_PUBLIC_URL, written before every rollout by the `app-env` pre-deploy hook) and plain
 *     PGHOST/PGPORT/PGDATABASE/PGSSLMODE plus PGUSER/PGPASSWORD from the `appResourceName(domain, slug, 'db')` Secret
 *     (optional: an app without a database simply has no credential), and APP_DOMAIN. Names come from domain AND
 *     slug, and nothing here depends on the env, so the manifest is byte-identical in `apps-dev` and `apps-prod`.
 *   - `pg` (MIT) reads PG* natively; no URL is composed. PGSSLMODE is `no-verify`: TLS to the cluster without pinning
 *     its CA (libpq's `require`); pg's own `require` means "verify against the public CA store", which refuses the
 *     cluster's own CA. Pinning the CA (verify-full) needs a CA-only volume in the manifest: a follow-up.
 *   - `native-deploy.ts appDeployFiles` merges it into the app container ONLY for `templateVersion: 2` apps with a
 *     domain; v1 apps never call it, so their manifests are unchanged.
 *   - An object rather than a bare list (decision recorded in the plan's W0 notes): `envFrom` cannot be expressed as
 *     `env` entries.
 *   - Loading this module registers D's pre-deploy hooks (`appdb/migrations.ts`): every deploy path renders through
 *     here, so the hooks are registered before C2's rollout calls `runPreDeployHooks`.
 */
import { appDbIdent, appResourceName } from '@tabs/software/lib/app-builder-contracts';
import { clusterHost, PG_PORT } from '@tabs/software/lib/appdb/database';
import '@tabs/software/lib/appdb/migrations';

export type K8sEnvVar = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
};
export type K8sEnvFrom = { secretRef: { name: string; optional?: boolean } };
export type AppDeploymentEnvBlock = { env: K8sEnvVar[]; envFrom: K8sEnvFrom[] };

/** The env block for the app container of `apps/<slug>/` in `domain`: identical in every env namespace. */
export function appDeploymentEnv(domain: string, slug: string): AppDeploymentEnvBlock {
  const db = appResourceName(domain, slug, 'db');
  return {
    env: [
      { name: 'APP_DOMAIN', value: domain },
      { name: 'PGHOST', value: clusterHost() },
      { name: 'PGPORT', value: String(PG_PORT) },
      { name: 'PGDATABASE', value: appDbIdent(domain, slug) },
      { name: 'PGSSLMODE', value: 'no-verify' },
      { name: 'PGUSER', valueFrom: { secretKeyRef: { name: db, key: 'username', optional: true } } },
      { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: db, key: 'password', optional: true } } },
    ],
    envFrom: [{ secretRef: { name: appResourceName(domain, slug, 'env'), optional: true } }],
  };
}
