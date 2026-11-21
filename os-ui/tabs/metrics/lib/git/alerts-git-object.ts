/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) — where a metric alert rule lives in the domain repo
 * USER STORY: As an alert owner I want my alert's history, version and diff from git, like every
 *             other object the OS builds.
 * ARCHITECTURE: Server-only resolver for `registerGitObject('metric-alert', …)`: the caller's own
 *   rule (an admin: any) → `metrics/alerts/<name>.yml` in its domain. `null` = not there or not
 *   yours; the kernel turns both into one `not_found`.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { GitObjectLocation } from '@core/infra/git-objects';
import { ensureHydrated, listAlertRules } from '@tabs/metrics/lib/alert-store';
import { ALERTS_PREFIX, alertName } from '@tabs/metrics/lib/git/alerts-native';

export async function metricAlertGitObjectResolver(user: CurrentUser, id: string): Promise<GitObjectLocation | null> {
  await ensureHydrated();
  const r = listAlertRules().find((x) => x.id === id);
  if (!r || (r.owner !== user.id && user.role !== 'admin')) return null;
  return { domain: r.domain, paths: [`${ALERTS_PREFIX}${alertName(r.id)}.yml`], trailerId: r.id, name: `${r.member} ${r.comparator} ${r.threshold}` };
}
