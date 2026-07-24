/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { agentDetail } from '@/lib/monitoring/detail-view';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/agent/[id] — the big AGENT diagnosis payload: 7-day run
 * history, cost/token trend, error/warning log + links. Scope is enforced by
 * `getSystem` inside `agentDetail` (a 403/404 there is the caller's own scope).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const detail = await agentDetail(user, id, Date.now());
    return NextResponse.json({ detail });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
