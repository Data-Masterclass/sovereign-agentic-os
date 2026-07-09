/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { buildOverview } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring — the scoped, attention-first overview (all five lenses +
 * operational alerts) for the signed-in viewer. Read-only. Scope is enforced
 * server-side from the viewer's identity (User=own · Builder=domain · Admin=
 * tenant+cluster), so the browser never receives out-of-scope signals.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const overview = await buildOverview(user);
    return NextResponse.json(overview);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
