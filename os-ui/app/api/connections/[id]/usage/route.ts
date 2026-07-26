/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { enableDataUsage } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Register the connection as a DATA SOURCE (the second usage). Database/API/SaaS →
 * dlt → Bronze; Drive → Files. The connection stays a governed agent tool at the
 * same time — one object, two usages. Body: { usage?: 'bronze' | 'files' }.
 */
export const POST = withRoute<{ id: string }, { usage?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    const usage = body?.usage === 'files' ? 'files' : body?.usage === 'bronze' ? 'bronze' : null;
    const connection = await enableDataUsage(id, user, usage);
    return NextResponse.json({ connection });
}, { parse: true, defaultStatus: 500 });
