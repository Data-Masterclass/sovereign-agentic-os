/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { revokeExposureSet, updateExposureSet, type ExposureSet, type ExposureInput } from '@/lib/connections/exposures';
import { recompileExposures, exposureFqns, type ExposurePushResult } from '@/lib/connections/exposure-policy';
import { markDatasetsSourceRevoked } from '@/lib/data/store';
import { reconcileSyncCron } from '@/lib/data/sync-cron';
import { addNotification } from '@/lib/notifications/store';
import { trace } from '@/lib/infra/agent-governed';

/**
 * The SHARED exposure mutation seams (lakehouse-expose-experience.md, Phase D). The Expose
 * UI's DELETE/PATCH routes and the MCP `revoke_exposure_set` / `update_exposure_set` tools
 * MUST behave BYTE-IDENTICALLY (the front-door invariant), so the multi-step propagation —
 * snapshot FQNs → mutate the registry → recompile OPA → (for revoke) freeze bound datasets,
 * tear down their sync CronJobs, notify each owner, trace per dataset — lives HERE and is
 * called by both. Duplicating it in the route + the tool is exactly the drift this avoids.
 *
 * Server-only: it imports the sync-cron k8s reconciler + the notification store, which must
 * never reach a client bundle.
 */

/** The result of a revoke: the mutated set, the OPA push outcome, and the datasets frozen. */
export type RevokePropagation = {
  exposure: ExposureSet;
  policy: ExposurePushResult;
  revokedDatasets: number;
};

/**
 * REVOKE an exposure set and propagate honestly (the exact DELETE-route behaviour):
 *   1. snapshot the FQNs it maps to BEFORE the flip (so dropped tables can be withdrawn),
 *   2. revoke it in the registry (admin re-gated in-lib),
 *   3. recompile all active exposures → OPA, withdrawing the snapshotted FQNs (live reads
 *      of the revoked tables drop to zero rows on this recompile),
 *   4. freeze every bound dataset (`connected.status='source-revoked'`) — tearing down each
 *      sync CronJob, notifying its owner, and tracing `dataset_source_revoked` per dataset.
 * Never silent: a frozen synced copy keeps its last-landed data; a live one shows the banner.
 */
export async function revokeExposureAndPropagate(exposureId: string, user: CurrentUser): Promise<RevokePropagation> {
  const before = await exposureFqns(exposureId);
  const exposure = await revokeExposureSet(exposureId, user);
  const policy = await recompileExposures({ withdraw: before });

  const affected = markDatasetsSourceRevoked(exposureId);
  for (const ds of affected) {
    if (ds.syncFrozen) {
      // Tear down the per-dataset sync CronJob (best-effort; the frozen copy is sovereign).
      void reconcileSyncCron(ds.id, null).catch(() => {});
    }
    addNotification({
      userId: ds.owner,
      kind: 'alert',
      title: 'Source revoked for a connected dataset',
      body: `“${ds.name}” can no longer be read — a platform admin revoked the source exposure it was adopted from. It now shows a “source revoked” state until it is re-adopted from an active exposure.`,
    });
    void trace({
      principal: user.domains[0] ?? user.id,
      tool: 'generate',
      input: { action: 'dataset_source_revoked', by: user.id, exposureId, datasetId: ds.id, domain: ds.domain },
      output: { status: 'source-revoked' },
      decision: 'allow',
    });
  }

  return { exposure, policy, revokedDatasets: affected.length };
}

/**
 * UPDATE an exposure set and recompile OPA (the exact PATCH-route behaviour): snapshot the
 * pre-edit FQNs so any table the edit DROPS (or a domain it removes) is withdrawn, apply the
 * edit in the registry (admin re-gated in-lib), then recompile the full active set. A dropped
 * table closes to zero rows on this recompile; the new set is re-pushed.
 */
export async function updateExposureAndRecompile(
  exposureId: string,
  user: CurrentUser,
  input: Partial<ExposureInput>,
): Promise<{ exposure: ExposureSet; policy: ExposurePushResult }> {
  const before = await exposureFqns(exposureId);
  const exposure = await updateExposureSet(exposureId, user, input);
  const policy = await recompileExposures({ withdraw: before });
  return { exposure, policy };
}
