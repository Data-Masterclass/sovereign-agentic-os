/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { buildStage } from './build/server.ts';
import { publishApprovedPromotion, type PublishOutcome } from './publish.ts';
import type { Principal, PromotionRequest } from './store.ts';

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
  });
}
