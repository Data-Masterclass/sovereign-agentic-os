/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { ExposureInput } from '@/lib/connections/exposures';
import { revokeExposureAndPropagate, updateExposureAndRecompile } from '@/lib/connections/exposure-propagation';

export const dynamic = 'force-dynamic';

/**
 * Edit an exposure set (admin-only). The FQNs it mapped to BEFORE the edit are snapshotted
 * so any table the edit drops (or a domain removed) is withdrawn from OPA and the recompile
 * re-pushes the new set — a dropped table closes to zero rows immediately. Shared with the
 * MCP `update_exposure_set` tool via `updateExposureAndRecompile` (front-door invariant).
 */
export const PATCH = withRoute<{ id: string; exposureId: string }, Partial<ExposureInput>>(
  async ({ user, params, body }) => {
    const { exposure, policy } = await updateExposureAndRecompile(params.exposureId, user, body);
    return NextResponse.json({ exposure, policy });
  },
  { parse: true, defaultStatus: 500 },
);

/** Revoke an exposure set (admin-only). Its FQNs are withdrawn from OPA — live reads go to
 *  zero rows on the next recompile (the fail-closed floor takes over). REVOCATION PROPAGATES
 *  to adopted datasets (Phase 2): every dataset bound to this exposure is frozen
 *  (`connected.status='source-revoked'`), its owner notified, and a `dataset_source_revoked`
 *  trace written per dataset — never silent. The whole propagation lives in
 *  `revokeExposureAndPropagate`, shared byte-for-byte with the MCP `revoke_exposure_set` tool. */
export const DELETE = withRoute<{ id: string; exposureId: string }>(async ({ user, params }) => {
  const { exposure, policy, revokedDatasets } = await revokeExposureAndPropagate(params.exposureId, user);
  return NextResponse.json({ exposure, policy, revokedDatasets });
}, { defaultStatus: 500 });
