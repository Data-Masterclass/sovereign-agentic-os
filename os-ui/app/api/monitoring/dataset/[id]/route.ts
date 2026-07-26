/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { datasetDetail } from '@/lib/monitoring/detail-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/dataset/[id] — the big DATASET diagnosis payload: build/version
 * timeline, freshness, the Data-Quality dashboard (per-rule pass/fail + violations +
 * trend), and lineage. Scope is enforced by `getDataset` inside `datasetDetail`.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const detail = await datasetDetail(user, id, Date.now());
  return NextResponse.json({ detail });
}, { defaultStatus: 500 });
