/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) — commit a domain's alert rules to `metrics/alerts/` in its repo
 * USER STORY: As a creator I want every alert I save to land in my domain repo as the dbt saved
 *             query MetricFlow runs, authored as me, so git is the alert's record.
 * ARCHITECTURE:
 *   - Server-only. Reads the domain's COMMITTED dbt YAML at HEAD (to resolve each member to its dbt
 *     metric), generates `metrics/alerts/**` for every rule of the domain (`alerts-native.ts`) and
 *     commits that subtree as the actor. A rule whose metric is not committed is reported pending.
 *   - Off unless `OS_ALERTS_NATIVE` is on (`alertsNativeEnabled`); the store stays the index.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { authorFor, commitSubtree, listTree, log, readBlob, type CommitResult } from '@core/infra/git-store';
import { ALERTS_PREFIX, generateAlertFiles, type AlertFileRule } from '@tabs/metrics/lib/git/alerts-native';

export type AlertCommit = { commit: CommitResult | null; pending: { id: string; reason: string }[] };

/** Regenerate and commit `domain`'s `metrics/alerts/` subtree from `rules`. */
export async function commitDomainAlerts(domain: string, rules: AlertFileRule[], actor: { id: string; name?: string | null; email?: string | null }, opts: { reposDir?: string } = {}): Promise<AlertCommit> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const sha = (await log(domain, { reposDir, limit: 1 }))[0]?.sha;
  const dbt = new Map<string, string>();
  if (sha) {
    for (const e of await listTree(domain, sha, { reposDir })) {
      if (/(^|\/)models\/.*\.ya?ml$/.test(e.path)) dbt.set(e.path, await readBlob(domain, sha, e.path, { reposDir }));
    }
  }
  const { files, pending } = generateAlertFiles(domain, rules, dbt);
  if (!sha && files.size === 0) return { commit: null, pending };
  const commit = await commitSubtree(domain, ALERTS_PREFIX, files, {
    reposDir,
    author: authorFor(actor).author,
    message: `metrics: alerts of ${domain} (${files.size} committed, ${pending.length} pending)`,
    trailers: { 'OS-Area': 'metrics-alerts' },
  });
  return { commit, pending };
}
