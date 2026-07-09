/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { buildStage } from './build/server.ts';
import { liveDataReachable, realTrino } from './build/live-clients.ts';
import { publishApprovedPromotion, type PublishOutcome } from './publish.ts';
import type { MaterializationVerifier, Principal, PromotionRequest } from './store.ts';

/**
 * The independent FAIL-CLOSED domain-table probe (#96) the publish runs right before
 * the tier flip. LIVE ⇒ a REAL governed `tableQueryable` probe on the exact domain
 * target (so a promotion can't flip while the gold lives only in `personal_<owner>`).
 * OFFLINE-MOCK ⇒ there is no domain schema to probe; the in-process build report's own
 * verify (against the mock's materialized set) is the gate, so this trusts the ✓ (the
 * offline-mock is a teaching path, never production — #96 is a live-schema bug).
 */
const verifyDomainTable: MaterializationVerifier = async (fqn, principal) => {
  if (await liveDataReachable()) return realTrino().tableQueryable(fqn, principal);
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
  return publishApprovedPromotion(req, approver, {
    buildPromote: (dataset, principal, write) => buildStage(dataset, 'promote', principal, write),
    verifyDomainTable,
  });
}
