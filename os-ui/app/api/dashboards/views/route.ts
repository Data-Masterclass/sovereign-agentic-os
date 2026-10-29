/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { listMetrics } from '@tabs/metrics/lib/store';
import { panelViewsFor, type RegistryViewDims } from '@tabs/dashboards/lib/panel-views';
import { listDatasets, getDataset } from '@tabs/data/lib/store';
import { viewName, registryDimensionMembers } from '@tabs/data/lib/metrics';

export const dynamic = 'force-dynamic';

/** The registry-derived dimension members per view for EVERY dataset the caller can see
 *  (personal datasets carry metrics too). `panelViewsFor` narrows to metric-backed views. */
function callerRegistryDims(user: CurrentUser): RegistryViewDims {
  const dims: RegistryViewDims = new Map();
  const groups = listDatasets(user);
  for (const s of [...groups.mine, ...groups.domain, ...groups.marketplace]) {
    try {
      const d = getDataset(s.id, user);
      dims.set(viewName(d), registryDimensionMembers(d));
    } catch { /* vanished between list and get → skip */ }
  }
  return dims;
}

/**
 * GET /api/dashboards/views — the panel-builder PALETTE: the governed views behind the
 * caller's visible metrics (`listMetrics`), with their measures + registry group-by
 * dimensions. A user never sees a view they aren't entitled to; a view's palette is exactly
 * what the governed-SQL executor can compute.
 */
export const GET = withRoute(async ({ user }) => {
  const groups = listMetrics(user);
  const members = [...groups.mine, ...groups.domain, ...groups.marketplace].map((m) => m.member);
  return NextResponse.json({ views: panelViewsFor(members, callerRegistryDims(user)) });
});
