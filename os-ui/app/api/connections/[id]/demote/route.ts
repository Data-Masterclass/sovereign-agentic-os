/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getConnectionForUser } from '@/lib/connections';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing on a connection one step down: Marketplace → Shared (Admin) →
 * Personal (owner/in-domain Builder+). Runs THROUGH the governed demote seam; the
 * store fn re-enforces the role gate. Never deletes the connection — only lowers
 * its visibility so it leaves the domain / marketplace surface.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    await demoteThroughSeam('connection', id, user);
    const connection = await getConnectionForUser(id, user);
    return NextResponse.json({ connection });
}, { defaultStatus: 500 });
