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
import { isAppDeployPath, validateAppDeployFile } from '@tabs/software/lib/native-deploy';

export const APP_DEPLOY_KIND = 'app-deploy';

export function registerAppDeployReceive(): void {
  registerRepoKind({
    kind: APP_DEPLOY_KIND,
    matches: isAppDeployPath,
    validate: (file) => validateAppDeployFile(file, config.softwareImageRegistry),
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
