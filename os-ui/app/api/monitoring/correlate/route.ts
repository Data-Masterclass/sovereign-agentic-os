/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { collectAll, correlate, scopeForUser } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/correlate?id=<itemId> — the correlation chain for a signal:
 * run → pipeline → system → artifact + the Governance cross-links (audit, cap).
 * Read-only and scope-safe: every hop is re-checked against the viewer's scope,
 * so following a link can never leak an out-of-scope artifact/node/run.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const scope = await scopeForUser(user);
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

    const all = await collectAll();
    const chain = correlate(scope, id, all);
    if (!chain) return NextResponse.json({ error: 'not found or out of scope' }, { status: 404 });

    return NextResponse.json({ correlation: chain });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
