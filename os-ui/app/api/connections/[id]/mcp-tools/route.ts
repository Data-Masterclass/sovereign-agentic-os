/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { verifyNotionConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Prove a Notion MCP connection is LIVE: run an MCP initialize + tools/list
 * round-trip through the stored token (owner-only) and return the advertised tool
 * names. The token is used only server-side as the bearer and never returned.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const result = await verifyNotionConnection(id, user.id);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
