/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    WP-54 — the receive-gate validator for an app's native deploy files
 * USER STORY: As a Builder I want a `git push` of an app's `k8s/` manifests to be checked by the same
 *             rules as `push_app_files`, so a manifest that could never be deployed (a foreign
 *             registry, a NetworkPolicy, another app's name) is refused at the door.
 * ARCHITECTURE:
 *   - One validator: `validateAppDeployFile` (native-deploy.ts), registered through the gate's
 *     `registerRepoKind` seam. The ingest records nothing and deploys nothing: a deploy is always
 *     `request_deploy` → Builder `decide_deploy`, which reads these files from git.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { registerRepoKind } from '@core/infra/git-receive';
import { isAppDeployPath, validateAppDeployFile, type DeployFileTarget } from '@tabs/software/lib/native-deploy';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { receiveAppTargets } from '@tabs/software/lib/apps';
import { v2CommittedRegistries } from '@tabs/software/lib/releases/rollout';

export const APP_DEPLOY_KIND = 'app-deploy';

/**
 * App Builder (C2): with the switch on, a pushed `k8s/` file is judged as the app(s) at that slug: a v2 app by its domain
 * (names `appResourceName`, image repository `apps/<domainKey>/<slug>`, only its own `-db`/`-env` Secrets: D's
 * `v2OwnSecrets`), a v1 app as before. The receive gate knows the slug, not the domain, so the file must be valid for one
 * of the apps with that slug; the release re-validates it against exactly one app. While the app registry is still
 * loading, a file that is not valid by v1's rules is refused with a retry message. With the switch off: v1 only, as before.
 */
export function validateDeployFileAtReceive(file: { path: string; content: string }): string | null {
  if (!appBuilderEnabled()) return validateAppDeployFile(file, config.softwareImageRegistry);
  const slug = /^apps\/([a-z0-9][a-z0-9-]*)\//.exec(file.path)?.[1];
  if (!slug) return null;
  const targets = receiveAppTargets(slug);
  if (targets === 'unknown') {
    const v1 = validateAppDeployFile(file, config.softwareImageRegistry);
    return v1 ? `${v1} (The OS is still loading its app registry; if this is an App Builder app, push again in a minute.)` : null;
  }
  if (!targets.some((t) => t.templateVersion === 2)) return validateAppDeployFile(file, config.softwareImageRegistry);
  const list: DeployFileTarget[] = targets.map((t) =>
    t.templateVersion === 2 ? { domain: t.domain, templateVersion: 2, registries: v2CommittedRegistries(config.appRegistry, config.appRegistryPull) } : { registries: [config.softwareImageRegistry] },
  );
  return validateAppDeployFile(file, config.softwareImageRegistry, { targets: list });
}

export function registerAppDeployReceive(): void {
  registerRepoKind({
    kind: APP_DEPLOY_KIND,
    matches: isAppDeployPath,
    validate: validateDeployFileAtReceive,
    ingest: async ({ files }) => ({
      kind: APP_DEPLOY_KIND,
      created: 0,
      updated: 0,
      skipped: 0,
      notes: files.length
        ? [`${files.length} deploy file(s) accepted; they take effect only through request_deploy and a Builder's decide_deploy.`]
        : [],
    }),
  });
}
