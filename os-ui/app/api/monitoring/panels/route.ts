/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { isPanelView, monitoringPanels } from '@tabs/monitoring/lib/panels/index';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/panels?view=agents|data|platform — the Monitoring panels for the signed-in
 * viewer, every number read from the component that holds it (Postgres run store, Langfuse
 * metrics, LiteLLM keys, OPA decision log in VictoriaLogs, Dagster, VictoriaMetrics). Read-only;
 * scoped server-side to the viewer's agent systems and datasets; `platform` is admin-only (403).
 */
export const GET = withRoute(async ({ user, req }) => {
  const view = new URL(req.url).searchParams.get('view') ?? 'agents';
  if (!isPanelView(view)) return NextResponse.json({ error: 'view must be agents, data or platform' }, { status: 400 });
  return NextResponse.json(await monitoringPanels(user, view));
}, { defaultStatus: 500 });
