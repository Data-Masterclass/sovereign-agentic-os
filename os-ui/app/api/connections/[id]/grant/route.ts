/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { grantToAgent } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Grant the connection to a specific agent, further restricted (never broadened).
 * Body: { agent, scope: 'read-only' | 'full' }. A read-only grant exposes only the
 * connection's Read tools to that agent — even when the connection allows writes.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const body = await req.json();
    const agent = String(body?.agent ?? '').trim();
    if (!agent) return NextResponse.json({ error: 'An agent principal is required' }, { status: 400 });
    const scope = body?.scope === 'full' ? 'full' : 'read-only';
    const connection = await grantToAgent(id, user, agent, scope);
    return NextResponse.json({ connection });
}, { defaultStatus: 500 });
