/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { SystemRecord } from './store.ts';

/**
 * PHYSICAL cleanup for an agent-system DELETE (never for archive — archive stops the
 * system + suspends its CronJob but KEEPS the repo so restore brings it back intact).
 *
 * A system's canonical `system.yaml` (+ each agent's AGENT.md / MEMORY.md) is
 * Forgejo-versioned in the per-system repo `os-<systemId>`, and a `cron` schedule
 * provisions a real batch/v1 CronJob. Deleting the registry record alone leaves both
 * behind — a "deleted" system whose repo and CronJob still exist isn't deleted. This
 * plans BOTH targets and purges them through the SAME clients Build/schedule use
 * (forgejo.deleteRepo + the CronJob reconcile-to-none), reporting each honestly:
 * an unreachable Forgejo / k8s API surfaces as `ok:false`, never a silent success.
 *
 * Pure planning (`purgePlan`) + injected executors, so the plan + outcome fold are
 * unit-testable without Forgejo or a cluster; the route injects the real clients.
 */

/** The per-system Forgejo repo name (mirrors the Build write path: `os-<systemId>`). */
export function systemRepoName(systemId: string): string {
  return `os-${systemId}`;
}

export type PurgeTargetKind = 'repo' | 'cronjob';
export type PurgeTarget = { kind: PurgeTargetKind; ref: string };

/**
 * What a DELETE must physically purge: always the repo; the CronJob only when the
 * system actually had a `cron` schedule (a manual/event system provisioned none, so
 * there is nothing to tear down and we don't fabricate a target).
 */
export function purgePlan(rec: SystemRecord): PurgeTarget[] {
  const out: PurgeTarget[] = [{ kind: 'repo', ref: systemRepoName(rec.id) }];
  if (rec.schedule.kind === 'cron') out.push({ kind: 'cronjob', ref: rec.id });
  return out;
}

export type PhysicalDeleteReport = {
  recordDeleted: boolean;
  physical: { target: string; ok: boolean; reason?: string }[];
};

/** Delete the system's Forgejo repo. Throws on a real failure (caller catches). */
export type RepoDeleteFn = (repo: string) => Promise<{ deleted: boolean }>;
/** Tear down the system's schedule CronJob. Returns an honest {ok} (never throws). */
export type CronTeardownFn = (systemId: string) => Promise<{ ok: boolean; detail: string }>;

/**
 * Purge every planned target, best-effort per target: one failure never blocks the
 * others, and every miss is reported with its reason. `recordDeleted` is always true
 * here — the caller has already removed the record; this reports the physical outcome.
 */
export async function purgeSystemResources(
  rec: SystemRecord,
  deps: { deleteRepo: RepoDeleteFn; teardownCron: CronTeardownFn },
): Promise<PhysicalDeleteReport> {
  const report: PhysicalDeleteReport = { recordDeleted: true, physical: [] };
  for (const t of purgePlan(rec)) {
    if (t.kind === 'repo') {
      try {
        await deps.deleteRepo(t.ref);
        report.physical.push({ target: `repo ${t.ref}`, ok: true });
      } catch (e) {
        report.physical.push({ target: `repo ${t.ref}`, ok: false, reason: (e as Error).message || 'delete failed' });
      }
    } else {
      const res = await deps.teardownCron(t.ref);
      report.physical.push({ target: `cronjob ${t.ref}`, ok: res.ok, ...(res.ok ? {} : { reason: res.detail }) });
    }
  }
  return report;
}
