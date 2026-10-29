/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { viewName } from '@tabs/data/lib/metrics';
import { getDashboardsForView, ensureHydrated } from '@tabs/dashboards/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Dashboards bound to THIS dataset's Cube view — the reverse list the Data tab's Publish
 * stage shows ("dashboards on this dataset", each linking to the Dashboards tab). We load
 * the dataset (view-scope check), derive its Cube view name, and filter the RLS-scoped
 * dashboard registry by that view. Read-only; never widens visibility.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  await ensureHydrated();
  const { id } = params;
  const dataset = getDataset(id, user);
  const view = viewName(dataset);
  return NextResponse.json({ dashboards: getDashboardsForView(view, user) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
