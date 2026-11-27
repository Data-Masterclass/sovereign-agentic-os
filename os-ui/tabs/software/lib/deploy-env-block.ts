/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the env block a v2 app's Deployment gets (its database and its env/secrets)
 * USER STORY: As an app builder I want my app's database connection and my own env and secrets wired into the
 *             platform-owned deployment manifest, identical in Dev and Prod, without ever seeing a password.
 * ARCHITECTURE:
 *   - EXTENSION POINT created by W0, owned by workstream D (spec section 7 "Injection"): `envFrom` the
 *     `appResourceName(domain, slug, 'env')` Secret (optional) and PGHOST/PGPORT/PGDATABASE/PGSSLMODE plus
 *     PGUSER/PGPASSWORD from the `appResourceName(domain, slug, 'db')` Secret. Names come from domain AND slug.
 *   - `native-deploy.ts appDeployFiles` merges it into the app container ONLY for `templateVersion: 2` apps with a
 *     domain; v1 apps never call it. The W0 stub returns an empty block, so the rendered manifest is unchanged.
 *   - An object rather than a bare list (decision recorded in the plan's W0 notes): `envFrom` cannot be expressed as
 *     `env` entries.
 */

export type K8sEnvVar = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
};
export type K8sEnvFrom = { secretRef: { name: string; optional?: boolean } };
export type AppDeploymentEnvBlock = { env: K8sEnvVar[]; envFrom: K8sEnvFrom[] };

/** The env block for the app container of `apps/<slug>/` in `domain`. W0 stub: empty. */
export function appDeploymentEnv(domain: string, slug: string): AppDeploymentEnvBlock {
  void domain;
  void slug;
  return { env: [], envFrom: [] };
}
