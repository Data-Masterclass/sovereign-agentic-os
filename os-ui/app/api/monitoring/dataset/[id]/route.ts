/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { datasetDetail } from '@/lib/monitoring/detail-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/dataset/[id] — the big DATASET diagnosis payload: build/version
 * timeline, freshness, the Data-Quality dashboard (per-rule pass/fail + violations +
 * trend), and lineage. Scope is enforced by `getDataset` inside `datasetDetail`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const detail = await datasetDetail(user, id, Date.now());
    return NextResponse.json({ detail });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
