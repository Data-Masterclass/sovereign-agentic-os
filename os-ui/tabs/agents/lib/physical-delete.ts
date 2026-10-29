/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { SystemRecord } from '@tabs/agents/lib/store';

/**
 * PHYSICAL cleanup for an agent-system DELETE (never for archive — archive stops the
 * system + suspends its CronJob but KEEPS the record so restore brings it back intact).
 *
 * A system's canonical `system.yaml` (+ each agent's AGENT.md / MEMORY.md) lives in the
 * agent STORE (no git backend), so a delete has no repo to purge. What it DOES leave
 * behind outside the store is the schedule: a `cron` schedule provisions a real
 * batch/v1 CronJob. This plans that target and purges it through the SAME client the
 * schedule path uses (the CronJob reconcile-to-none), reporting it honestly: an
 * unreachable k8s API surfaces as `ok:false`, never a silent success.
 *
 * Pure planning (`purgePlan`) + injected executors, so the plan + outcome fold are
 * unit-testable without a cluster; the route injects the real client.
 */

export type PurgeTargetKind = 'cronjob';
export type PurgeTarget = { kind: PurgeTargetKind; ref: string };

/**
 * What a DELETE must physically purge: the CronJob, and only when the system actually
 * had a `cron` schedule (a manual/event system provisioned none, so there is nothing
 * to tear down and we don't fabricate a target).
 */
export function purgePlan(rec: SystemRecord): PurgeTarget[] {
  return rec.schedule.kind === 'cron' ? [{ kind: 'cronjob', ref: rec.id }] : [];
}

export type PhysicalDeleteReport = {
  recordDeleted: boolean;
  physical: { target: string; ok: boolean; reason?: string }[];
};

/** Tear down the system's schedule CronJob. Returns an honest {ok} (never throws). */
export type CronTeardownFn = (systemId: string) => Promise<{ ok: boolean; detail: string }>;

/**
 * Purge every planned target, best-effort per target: one failure never blocks the
 * others, and every miss is reported with its reason. `recordDeleted` is always true
 * here — the caller has already removed the record; this reports the physical outcome.
 */
export async function purgeSystemResources(
  rec: SystemRecord,
  deps: { teardownCron: CronTeardownFn },
): Promise<PhysicalDeleteReport> {
  const report: PhysicalDeleteReport = { recordDeleted: true, physical: [] };
  for (const t of purgePlan(rec)) {
    const res = await deps.teardownCron(t.ref);
    report.physical.push({ target: `cronjob ${t.ref}`, ok: res.ok, ...(res.ok ? {} : { reason: res.detail }) });
  }
  return report;
}
