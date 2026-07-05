/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listDashboards, ensureHydrated } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * The Dashboards tab tiles — dashboards the user may open, grouped Mine / Domain /
 * Marketplace (OPA/tier-filtered). Double-click opens via a guest token (see
 * /api/dashboards/embed) with the viewer's RLS, so a shared tile still shows only the
 * viewer's rows.
 */
export async function GET() {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    return NextResponse.json(listDashboards(user));
  } catch (e) {
    return errorResponse(e);
  }
}
