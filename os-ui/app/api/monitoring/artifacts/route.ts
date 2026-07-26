/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { artifactMonitoring } from '@/lib/monitoring/artifacts-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/artifacts — the redesigned, artifact-centric Monitor feed:
 * every agent system + dataset the viewer can access (My · Domain · Company), each
 * with rolled-up health. Read-only, scoped to the caller's own governed lists.
 */
export const GET = withRoute(async ({ user }) => {
  const feed = await artifactMonitoring(user, Date.now());
  return NextResponse.json(feed);
}, { defaultStatus: 500 });
