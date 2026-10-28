/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { buildStage } from './build/server.ts';
import { queryToolReachable, realTrino } from './build/live-clients.ts';
import { publishApprovedPromotion, rematerializeDomainTable, type PublishOutcome, type RematerializeOutcome } from './publish.ts';
import { promoteAsView, ensureHydrated as ensureSettingsHydrated } from '../../platform-admin/settings.ts';
import type { MaterializationVerifier, Principal, PromotionRequest } from './store.ts';

/**
 * The independent FAIL-CLOSED domain-table probe (#96) the publish runs right before
 * the tier flip. Gated on the WRITE/Trino path the domain table lives in
 * (`queryToolReachable`). LIVE ⇒ a REAL
 * governed `tableQueryable` probe on the exact domain target. Only a genuinely unreachable
 * query-tool (true offline-mock — no domain schema to probe) trusts the in-process build ✓.
 */
const verifyDomainTable: MaterializationVerifier = async (fqn, principal) => {
  if (await queryToolReachable()) return realTrino().tableQueryable(fqn, principal);
  return true;
};

/**
 * The server-boundary publisher every approval surface uses for `dataset_promote`
 * (Governance queue, agent approvals, MCP `approve_promotion`): the pure
 * {@link publishApprovedPromotion} wired to the real Build runner — LIVE adapters
 * when the stack is reachable, the honest offline-mock otherwise. One entry point,
 * so no surface can flip a tier without the physical publish passing.
 */
export async function publishPromotionLive(
  req: PromotionRequest,
  approver: Principal,
): Promise<PublishOutcome> {
  await ensureSettingsHydrated(); // restore the persisted promoteAsView flag before the gate read
  const outcome = await publishApprovedPromotion(req, approver, {
    buildPromote: (dataset, principal, write) => buildStage(dataset, 'promote', principal, write),
    verifyDomainTable,
    // Promote-as-view platform flag (default OFF): a NEW promote publishes a governed VIEW
    // over the owner's personal lane instead of a physical CTAS copy. Existing promoted
    // datasets are never migrated (their recorded `domainArtifact` decides demote/reconcile).
    asView: promoteAsView(),
  });
  return outcome;
}

/**
 * The server-boundary RE-MATERIALIZE (Northpeak fix): re-run the publish CTAS for an
 * already-promoted dataset whose Gold was rebuilt, refreshing the governed domain table +
 * clearing the STALE marker. Wired to the SAME live Build runner + domain probe as promotion,
 * so a rebuild's new data reaches every dashboard instead of drifting silently.
 */
export async function rematerializeDomainTableLive(
  datasetId: string,
  operator: Principal,
): Promise<RematerializeOutcome> {
  return rematerializeDomainTable(datasetId, operator, {
    buildPromote: (dataset, principal, write) => buildStage(dataset, 'promote', principal, write),
    verifyDomainTable,
  });
}
