/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { revokeExposureSet, updateExposureSet, allActiveExposures, type ExposureSet, type ExposureInput } from '@/lib/connections/exposures';
import { recompileExposures, exposureFqns, type ExposurePushResult } from '@/lib/connections/exposure-policy';
import { listAdoptions, revokeActionAdoption } from '@/lib/connections/action-adoptions';
import { removeLiveRegistration } from '@/lib/connections/warehouse/k8s-registration';
import { markDatasetsSourceRevoked } from '@/lib/data/store';
import { reconcileSyncCron } from '@/lib/data/sync-cron';
import { addNotification } from '@/lib/notifications/store';
import { trace } from '@/lib/infra/agent-governed';
import { config } from '@/lib/core/config';
import type { PhysicalTarget } from '@/lib/connections/connections-physical-delete';

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

/**
 * TEAR DOWN everything a connection GRANTED before its record is deleted (C1). Deleting the
 * record + vault secret alone leaves the grants it seeded live: its exposure sets still
 * withdraw-on-recompile? No — nothing recompiles them; its adopted action tools still arm
 * other domains; and a live-registered warehouse catalog still federates through Trino with
 * a materialized credential COPY the delete report would falsely claim purged. This is the
 * ONE place that unwinds all three, in the SAFE order, appending an honest outcome to the
 * PhysicalDeleteReport. Called by BOTH delete paths + the folder-cascade delete, BEFORE the
 * record/secret purge so the exposures/adoptions still resolve.
 *
 * ORDER (each best-effort, never throws — a "deleted" connection must not be undeletable):
 *   1. every active exposure OF THIS CONNECTION → `revokeExposureAndPropagate` (honest
 *      freeze/notify/trace + OPA withdraw), so no FQN it exposed keeps reading;
 *   2. every action ADOPTION bound to those exposures → `revokeActionAdoption` (the
 *      cross-domain action tools die immediately — the intersection recomputes per call);
 *   3. for a live-registered WAREHOUSE connection → `removeLiveRegistration` (drop the Trino
 *      catalog key + delete the `trino-ext-<catalog>` credential-copy Secret + roll Trino).
 * Runs AS the deleting user (the exposure/adoption revokes re-gate admin in-lib). K8s work
 * stays server-only (this module is `server-only`).
 */
export async function teardownConnection(c: Connection, user: CurrentUser): Promise<PhysicalTarget[]> {
  const out: PhysicalTarget[] = [];

  // 1 + 2. Revoke every exposure of this connection and the adoptions bound to it.
  const exposures = (await allActiveExposures()).filter((e) => e.connectionId === c.id);
  for (const e of exposures) {
    // Revoke the adoptions bound to THIS exposure first (they reference it by id).
    try {
      const adoptions = await listAdoptions(e.id);
      for (const a of adoptions) {
        if (a.revoked) continue;
        try {
          await revokeActionAdoption(a.id, user);
          out.push({ target: `adoption ${a.id} (${a.domain}/${a.entities.join(',')})`, ok: true, reason: 'action adoption revoked' });
        } catch (err) {
          out.push({ target: `adoption ${a.id}`, ok: false, reason: (err as Error).message || 'adoption revoke failed' });
        }
      }
    } catch (err) {
      out.push({ target: `adoptions for exposure ${e.id}`, ok: false, reason: (err as Error).message || 'could not list adoptions' });
    }
    // Then revoke the exposure itself (honest freeze/notify/trace + OPA withdraw).
    try {
      const res = await revokeExposureAndPropagate(e.id, user);
      out.push({ target: `exposure ${e.id} (${e.name})`, ok: true, reason: `revoked + OPA recompiled; ${res.revokedDatasets} bound dataset(s) frozen` });
    } catch (err) {
      out.push({ target: `exposure ${e.id}`, ok: false, reason: (err as Error).message || 'exposure revoke failed' });
    }
  }

  // 3. Remove a live-registered warehouse catalog (drop catalog key + credential-copy Secret).
  if (c.template === 'warehouse' && c.warehouse?.catalog) {
    if (!config.externalConnectorsEnabled) {
      // External warehouses are gated OFF — no live registration could exist. Say so honestly.
      out.push({ target: `trino catalog ${c.warehouse.catalog}`, ok: true, reason: 'external warehouses disabled — no live registration to remove' });
    } else {
      try {
        const res = await removeLiveRegistration(c.warehouse.catalog, { namespace: config.platformNamespace });
        out.push({
          target: `trino catalog ${c.warehouse.catalog} + trino-ext secret`,
          ok: res.ok || !res.live, // not-in-cluster (live:false) is not a hard failure of the delete
          reason: res.detail,
        });
      } catch (err) {
        out.push({ target: `trino catalog ${c.warehouse.catalog}`, ok: false, reason: (err as Error).message || 'live-registration removal failed' });
      }
    }
  }

  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'connection_teardown', by: user.id, connectionId: c.id, exposures: exposures.length },
    output: { targets: out.map((t) => ({ target: t.target, ok: t.ok })) },
    decision: 'allow',
  });
  return out;
}
