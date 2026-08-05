/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listExposureSets, createExposureSet, type ExposureInput } from '@/lib/connections/exposures';
import { recompileExposures } from '@/lib/connections/exposure-policy';

export const dynamic = 'force-dynamic';

/** List every exposure set for a warehouse connection (admin manage UI). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  return NextResponse.json({ exposures: await listExposureSets(params.id, user) });
}, { defaultStatus: 500 });

/**
 * Create an exposure set (admin-only; re-gated in the lib). On success the exposure
 * compiles to OPA immediately — each listed table becomes a `data.governance.tables`
 * entry shared with the assigned domains, so a live external catalog opens to exactly
 * those domains (and stays fail-closed for everyone else).
 */
export const POST = withRoute<{ id: string }, ExposureInput>(async ({ user, params, body }) => {
  const exposure = await createExposureSet(params.id, user, body);
  const policy = await recompileExposures();
  return NextResponse.json({ exposure, policy });
}, { parse: true, defaultStatus: 500 });
