/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Remove a pre-B2 sync CronJob — the only half of the old scheduler B4 keeps
 * USER STORY: As an operator upgrading into the Dagster world I want the per-dataset `batch/v1`
 *             CronJob a pre-B2 save left behind to be DELETED when the sync is saved again or its
 *             source is revoked, so one slice can never fire twice; and I want nothing in the OS
 *             able to create one again.
 * ARCHITECTURE:
 *   - Engine rebuild B4 deleted `sync-cron.ts`: the OS no longer provisions CronJobs for syncs
 *     (checklist D7), and the fallback sweeps that matched crons in-process are gone with it. What
 *     survives is this delete-only reconciler, because an UPGRADE must still clean up.
 *   - Idempotent and honest: a 404 is a benign no-op, an unreachable API server is `live: false`
 *     with the reason — never a claim that the CronJob is gone when nobody could check.
 *   - The k8s client is injected, so this is unit-testable with no cluster.
 */
import { config } from '@core/kernel/config';
import { k8s as liveK8s } from '@core/infra/k8s';

export type CronK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type SyncCronOpts = { k8s?: CronK8s; namespace?: string };

export type SyncCronAction = 'created' | 'updated' | 'deleted' | 'noop';
export type SyncCronOutcome = {
  ok: boolean;
  /** True only when a real cluster confirmed the effect. */
  live: boolean;
  action: SyncCronAction;
  detail: string;
  name: string;
};

/** Deterministic, RFC1123-safe CronJob name for a dataset (one per dataset) — the name a pre-B2
 *  save used, so the cleanup addresses exactly those objects. */
export function syncCronJobName(datasetId: string): string {
  const slug = datasetId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `data-sync-${slug || 'dataset'}`.slice(0, 52).replace(/-+$/g, '');
}

const UNREACHABLE =
  'Kubernetes API unreachable — a pre-B2 sync CronJob may still exist for this dataset; it is removed on the next save once connectivity is restored.';

/**
 * Ensure no `batch/v1` CronJob lingers for a dataset's sync. Never throws.
 */
export async function removeSyncCronJob(datasetId: string, options: SyncCronOpts = {}): Promise<SyncCronOutcome> {
  const k8s = options.k8s ?? (liveK8s as CronK8s);
  const namespace = options.namespace ?? config.platformNamespace;
  const name = syncCronJobName(datasetId);
  const object = `/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`;

  const del = await k8s('DELETE', object);
  if (del.status === 0) return { ok: false, live: false, action: 'noop', name, detail: UNREACHABLE };
  if (del.status === 404) return { ok: true, live: true, action: 'noop', name, detail: 'No sync CronJob to remove.' };
  if (del.status === 200 || del.status === 202) return { ok: true, live: true, action: 'deleted', name, detail: `Deleted the pre-B2 sync CronJob ${name}.` };
  return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob deletion (HTTP ${del.status}).` };
}
