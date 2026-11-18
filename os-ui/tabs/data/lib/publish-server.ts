/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { offlineMockAllowed, refuseOfflineMock } from '@core/kernel/offline-mock';
import { buildStage } from '@tabs/data/lib/build/server';
import { queryToolReachable, realTrino } from '@tabs/data/lib/build/live-clients';
import { publishApprovedPromotion, rematerializeDomainTable, type PublishOutcome, type RematerializeOutcome } from '@tabs/data/lib/publish';
import { promoteAsView, ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { requestPromotion, type MaterializationVerifier, type Principal, type PromotionRequest } from '@tabs/data/lib/store';
import { canPromote } from '@core/kernel/session';

/**
 * The independent FAIL-CLOSED domain-table probe (#96) the publish runs right before
 * the tier flip. Gated on the WRITE/Trino path the domain table lives in
 * (`queryToolReachable`). LIVE ⇒ a REAL
 * governed `tableQueryable` probe on the exact domain target. Only a genuinely unreachable
 * query-tool (true offline-mock — no domain schema to probe) trusts the in-process build ✓.
 *
 * THE HONESTY GATE (2026-11-18). `return true` is a fallback that reports SUCCESS: it flips a
 * dataset's tier to `asset` on the strength of a probe that never ran. On a real deployment an
 * unreachable query-tool means the publish cannot be verified, and an unverified publish must
 * not happen — so refuse rather than assert. The teaching flow keeps the trust-the-build path,
 * because on a laptop there is genuinely no domain schema to probe.
 */
const verifyDomainTable: MaterializationVerifier = async (fqn, principal) => {
  if (await queryToolReachable()) return realTrino().tableQueryable(fqn, principal);
  if (!offlineMockAllowed()) {
    refuseOfflineMock(
      `Cannot verify the domain table ${fqn}: the governed query path (query-tool → Trino) is ` +
        'unreachable, so the publish cannot be confirmed. The dataset’s tier was not changed.',
    );
  }
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
 * PROMOTE-OR-PROPOSE for a dataset — the twin of `promoteFileOrPropose`, and the one entry
 * both front doors (`/api/data/datasets/[id]/promote` and MCP `request_promotion`) use.
 *
 * WHY. Both doors always FILED, and `canApprove` refuses the requester whatever their rank
 * (four-eyes). An owner who ALSO holds the rung-1 authority filed a request only they could
 * decide — so a domain admin's or the platform admin's OWN dataset could never leave My.
 *
 * It widens nothing: the direct branch needs `requestPromotion` to pass (OWNER-only trigger,
 * Silver/Gold built, the transparency gate) AND `canPromote(role,'Personal')`, and then runs
 * the FULL physical publish through {@link publishPromotionLive} as that same identity — the
 * governed CTAS, the independent domain-table probe, the OPA push and the conformance check,
 * with the tier flipping only on ✓. A failed materialization returns the real error and the
 * dataset stays private, exactly as on the approval path.
 *
 * `requestPromotion` runs FIRST on both branches, so the one-shot cannot skip a gate the
 * proposing path enforces. The enqueue stays with the caller (same reason as for files).
 */
export async function promoteDatasetOrPropose(
  id: string,
  user: Principal,
  opts: { visibility?: PromotionRequest['visibility']; grants?: PromotionRequest['grants'] } = {},
): Promise<
  | { promoted: true; outcome: PublishOutcome }
  | { promoted: false; request: PromotionRequest }
> {
  const request = requestPromotion(id, user, opts); // owner-only + Silver/Gold + transparency
  if (!canPromote(user.role, 'Personal')) return { promoted: false, request };
  return { promoted: true, outcome: await publishPromotionLive(request, user) };
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
