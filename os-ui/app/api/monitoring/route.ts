/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { buildOverview } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring — the scoped, attention-first overview (all five lenses +
 * operational alerts) for the signed-in viewer. Read-only. Scope is enforced
 * server-side from the viewer's identity (User=own · Builder=domain · Admin=
 * tenant+cluster), so the browser never receives out-of-scope signals.
 */
export const GET = withRoute(async ({ user }) => {
  const overview = await buildOverview(user);
  return NextResponse.json(overview);
}, { defaultStatus: 500 });
