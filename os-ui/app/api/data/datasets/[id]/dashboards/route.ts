/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { cubeViewName } from '@/lib/data/metrics';
import { getDashboardsForView, ensureHydrated } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * Dashboards bound to THIS dataset's Cube view — the reverse list the Data tab's Publish
 * stage shows ("dashboards on this dataset", each linking to the Dashboards tab). We load
 * the dataset (view-scope check), derive its Cube view name, and filter the RLS-scoped
 * dashboard registry by that view. Read-only; never widens visibility.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    await ensureHydrated();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    const view = cubeViewName(dataset);
    return NextResponse.json({ dashboards: getDashboardsForView(view, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
