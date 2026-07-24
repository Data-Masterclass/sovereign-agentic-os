/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { artifactMonitoring } from '@/lib/monitoring/artifacts-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/artifacts — the redesigned, artifact-centric Monitor feed:
 * every agent system + dataset the viewer can access (My · Domain · Company), each
 * with rolled-up health. Read-only, scoped to the caller's own governed lists.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const feed = await artifactMonitoring(user, Date.now());
    return NextResponse.json(feed);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
