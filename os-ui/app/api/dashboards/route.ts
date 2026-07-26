/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { listDashboards, ensureHydrated } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * The Dashboards tab tiles — dashboards the user may open, grouped Mine / Domain /
 * Marketplace (OPA/tier-filtered). Opening one renders it natively (Apache ECharts on the
 * governed Cube layer); each panel resolves via /api/dashboards/panel-query under the
 * viewer's RLS, so a shared tile still shows only the viewer's rows.
 */
export const GET = withRoute(async ({ user, req }) => {
  // ?archived=1 additionally returns soft-archived dashboards (their own section),
  // so an archived dashboard stays openable → its detail exposes Restore + Delete.
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  return NextResponse.json(listDashboards(user, { includeArchived }));
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });
