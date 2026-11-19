/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { buildOverview } from '@tabs/monitoring/lib/index';
import { isRunListStatus } from '@tabs/monitoring/lib/adapters/run-store-runs';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring — the scoped, attention-first overview (all five lenses +
 * operational alerts) for the signed-in viewer. Read-only. Scope is enforced
 * server-side from the viewer's identity (User=own · Builder=domain · Admin=
 * tenant+cluster), so the browser never receives out-of-scope signals.
 * Optional `?systemId=` and `?status=` narrow the runs lens to agent runs of one system / status.
 */
export const GET = withRoute(async ({ user, req }) => {
  const q = new URL(req.url).searchParams;
  const systemId = (q.get('systemId') ?? '').trim() || undefined;
  const rawStatus = (q.get('status') ?? '').trim();
  const status = isRunListStatus(rawStatus) ? rawStatus : undefined;
  const overview = await buildOverview(user, systemId || status ? { runs: { systemId, status } } : {});
  return NextResponse.json(overview);
}, { defaultStatus: 500 });
