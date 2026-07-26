/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { agentDetail } from '@/lib/monitoring/detail-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/agent/[id] — the big AGENT diagnosis payload: 7-day run
 * history, cost/token trend, error/warning log + links. Scope is enforced by
 * `getSystem` inside `agentDetail` (a 403/404 there is the caller's own scope).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const detail = await agentDetail(user, id, Date.now());
  return NextResponse.json({ detail });
}, { defaultStatus: 500 });
